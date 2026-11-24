import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { CONTRACT } from "../src/generated/contract";
import { call, connectAssistant, connectDevice, db, idem, makeEnv, saveText, signIn, withHelper, analysed } from "./helpers";

describe("K22 public-facing safety", () => {
  it("K22 limits: public endpoints are rate limited per caller address, and the answer says when to retry", async () => {
    const env = makeEnv({ PUBLIC_RATE_PER_10_MIN: "4" });
    const headers = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 4; i++) expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "a@example.com" }, headers })).status).toBe(202);
    const limited = await call(env, "POST", "/v1/auth/email-codes", { body: { email: "a@example.com" }, headers });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address is not affected; the window passes.
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "a@example.com" }, headers: { "cf-connecting-ip": "203.0.113.8" } })).status).toBe(202);
    advance(10 * MINUTE);
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "a@example.com" }, headers })).status).toBe(202);
    // The other public endpoints are limited the same way.
    for (const [method, path, body] of [
      ["POST", "/v1/auth/sessions", { email: "a@example.com", code: "000000", device_name: "x", client: "web" }],
      ["POST", "/v1/device-codes", { device_name: "x", client: "web", requested_tier: "save" }],
      ["POST", "/oauth/register", { redirect_uris: ["https://a.example/cb"] }],
    ] as [string, string, unknown][]) {
      let last = 0;
      for (let i = 0; i < 5; i++) last = (await call(env, method, path, { body, headers: { "cf-connecting-ip": "198.51.100.9" } })).status;
      expect(`${path} ${last}`).toBe(`${path} 429`);
    }
    // The address itself is not stored, only a hash of it.
    expect(JSON.stringify(await db(env, "SELECT key FROM rate_limits"))).not.toContain("203.0.113");
  });

  it("K22 limits: saving is rate limited per device", async () => {
    const env = makeEnv({ SAVE_RATE_PER_MINUTE: "3" });
    const ann = await signIn(env);
    const other = await connectDevice(env, ann, "save");
    for (let i = 0; i < 3; i++) await saveText(env, ann.token, `Thought ${i}.`);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "One too many." }, idem: idem() });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).not.toBeNull();
    expect((await call(env, "POST", "/v1/items", { token: other.token, body: { kind: "text", text: "Another device." }, idem: idem() })).status).toBe(201);
    advance(MINUTE);
    expect((await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "A minute later." }, idem: idem() })).status).toBe(201);
  });

  it("K22 https: plain http is redirected for reads and refused for writes; local development can opt in", async () => {
    const env = makeEnv();
    const get = await call(env, "GET", "http://core.test/v1/meta");
    expect(get.status).toBe(308);
    expect(get.headers.get("location")).toBe("https://core.test/v1/meta");
    const post = await call(env, "POST", "http://core.test/v1/auth/email-codes", { body: { email: "a@example.com" } });
    expect(post.status).toBe(400);
    expect((await call(env, "GET", "http://localhost:8801/v1/meta")).status).toBe(308);
    const dev = makeEnv({ ALLOW_HTTP: "1" });
    expect((await call(dev, "GET", "http://localhost:8801/v1/meta")).status).toBe(200);
    expect((await call(dev, "GET", "http://core.test/v1/meta")).status).toBe(308);
    expect((await call(env, "GET", "/v1/meta")).headers.get("strict-transport-security")).toContain("max-age=");
  });

  it("K22 credentials: nothing that works as a credential is stored in the clear", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const reader = await connectDevice(env, ann, "read");
    const created = await call(env, "POST", "/v1/device-codes", { body: { device_name: "Waiting", client: "web", requested_tier: "read" } });
    const login = await call(env, "POST", "/admin/login-codes", { token: "test-admin-secret", body: { email: ann.email } });
    const secrets = [ann.token, reader.token, helper.access, helper.refresh, created.json.poll_secret, created.json.code, login.json.code];
    const tables = (await db(env, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'notes_fts%' AND name NOT LIKE 'd1_%'")).map((t) => t.name);
    expect(tables.length).toBeGreaterThan(20);
    let dump = "";
    for (const t of tables) dump += JSON.stringify(await db(env, `SELECT * FROM ${t}`));
    for (const s of secrets) expect(dump.includes(s)).toBe(false);
    for (const row of await db(env, "SELECT credential_hash FROM devices")) expect(row.credential_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("K22 usage: every hand-in is recorded; built-in assistants are marked as not self-reported, connected ones as self-reported", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await analysed(env, ann, helper, ["One.", "Two."]); // triage by the core (no hand-in), one hand-in by the helper
    const rows = await db(env, "SELECT kind, items, self_reported FROM usage_records");
    expect(rows).toEqual([{ kind: "analysis", items: 2, self_reported: 1 }]);
    // (The built-in side is covered in "K8 triage" and "K11 worker": self_reported = 0.)
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "GET", "/v1/usage", { token: reader.token })).status).toBe(403);
  });

  it("K22 errors: every error has the same body, a code from the contract, and a message in the caller's language", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const cases: [string, string, any, number][] = [
      ["GET", "/v1/items?state=today", { token: null }, 401],
      ["GET", "/v1/items?state=nope", { token: ann.token }, 400],
      ["GET", "/v1/items", { token: ann.token }, 400],
      ["GET", "/v1/items?state=today&limit=101", { token: ann.token }, 400],
      ["GET", "/v1/items/itm_none", { token: ann.token }, 404],
      ["GET", "/v1/digests/not-a-day", { token: ann.token }, 400],
      ["POST", "/v1/items", { token: ann.token, raw: "{", headers: { "content-type": "application/json", "idempotency-key": "abcdefgh" } }, 400],
      ["PATCH", "/v1/settings", { token: ann.token, body: { theme: "dark" } }, 400],
      ["PATCH", "/v1/settings", { token: ann.token, body: { timezone: "Mars/Olympus" } }, 400],
      ["GET", "/v1/unknown", { token: ann.token }, 404],
    ];
    for (const [method, path, opts, status] of cases) {
      for (const lang of ["en", "zh"]) {
        const r = await call(env, method, path, { ...opts, headers: { ...(opts.headers ?? {}), "accept-language": lang } });
        expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} ${status}`);
        expect(Object.keys(r.json)).toEqual(["error"]);
        expect(Object.keys(r.json.error)).toEqual(["code", "message"]);
        expect(CONTRACT.errorCodes).toContain(r.json.error.code);
        expect(/[一-鿿]/.test(r.json.error.message)).toBe(lang === "zh");
      }
    }
  });

  it("K22 cors: the web origin and browser extensions may call the API; other sites may not", async () => {
    const env = makeEnv();
    const allowed = async (origin: string, path = "/v1/meta") => (await call(env, "GET", path, { headers: { origin } })).headers.get("access-control-allow-origin");
    expect(await allowed("https://app.test")).toBe("https://app.test");
    expect(await allowed("chrome-extension://abcdefghijklmnop")).toBe("chrome-extension://abcdefghijklmnop");
    expect(await allowed("moz-extension://1234")).toBe("moz-extension://1234");
    expect(await allowed("https://evil.example")).toBeNull();
    expect(await allowed("http://localhost:5173")).toBeNull();
    // Assistants run anywhere: the authorization server and the assistant endpoint answer any origin.
    expect(await allowed("https://any.example", "/.well-known/oauth-authorization-server")).toBe("https://any.example");
    const pre = await call(env, "OPTIONS", "/v1/items", { headers: { origin: "chrome-extension://abcdefghijklmnop", "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("Idempotency-Key");
    expect((await call(env, "OPTIONS", "/v1/items", { headers: { origin: "https://evil.example" } })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("K22 assistants: an assistant can do nothing but its contract — no devices, no settings, no deleting, no lists", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    const id = await saveText(env, ann.token, "Untouchable.");
    for (const op of CONTRACT.operations.filter((o) => o.auth === "device")) {
      const path = op.path.replace("{day}", "latest").replace("{id}", id).replace("{item_id}", id).replace(/\{\w+\}/g, "x");
      const r = await call(env, op.method, path, { token: helper.access, body: op.body ? {} : undefined, idem: idem() });
      expect(`${op.operationId} ${r.status}`).toBe(`${op.operationId} 401`);
    }
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).status).toBe(200);
  });
});

describe("routing to the web app", () => {
  it("web: a path that is not API, OAuth, assistant endpoint, admin or calendar image goes to the web app; without one it is 404", async () => {
    const seen: string[] = [];
    const web = { fetch: async (req: Request) => (seen.push(new URL(req.url).pathname), new Response("<html>app</html>", { headers: { "content-type": "text/html" } })) } as unknown as Fetcher;
    const env = makeEnv({ WEB: web });
    for (const path of ["/", "/today", "/authorize?request=req_1", "/approve?code=ABC-DEF", "/assets/app.js", "/v2/items"]) {
      const r = await call(env, "GET", path);
      expect(r.status).toBe(200);
      expect(r.text).toBe("<html>app</html>");
    }
    expect(seen).toEqual(["/", "/today", "/authorize", "/approve", "/assets/app.js", "/v2/items"]);
    for (const path of ["/v1/meta", "/v1/nope", "/oauth/nope", "/mcp", "/admin/invites", "/c/x.svg", "/.well-known/oauth-authorization-server"]) {
      await call(env, "GET", path);
    }
    expect(seen).toHaveLength(6);
    const bare = makeEnv();
    const r = await call(bare, "GET", "/today");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });
});
