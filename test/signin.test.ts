import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { ADMIN, call, db, invite, loginCode, makeEnv, signIn, TZ, type Outbound } from "./helpers";

const session = (email: string, code: string) => ({ body: { email, code, device_name: "Laptop", client: "web", timezone: TZ } });

describe("K1 sign-in", () => {
  it("K1 sign-in: asking for a code always answers 202, and only an invited email gets one", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const a = await call(env, "POST", "/v1/auth/email-codes", { body: { email: "Ann@Example.com" } });
    const b = await call(env, "POST", "/v1/auth/email-codes", { body: { email: "stranger@example.com" } });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.text).toBe(b.text);
    const codes = await db(env, "SELECT email FROM login_codes");
    expect(codes.map((c) => c.email)).toEqual(["ann@example.com"]);
  });

  it("K1 sign-in: with a mail provider configured the code is emailed; without one nothing is sent", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init?.body)), auth: (init?.headers as any).authorization });
      return Response.json({ id: "1" });
    };
    const quiet = makeEnv({ OUTBOUND: outbound });
    await invite(quiet, "ann@example.com");
    await call(quiet, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com" } });
    expect(sent).toHaveLength(0);

    const mail = makeEnv({ OUTBOUND: outbound, RESEND_API_KEY: "re_test", EMAIL_FROM: "Sign in <login@example.com>" });
    await call(mail, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com", lang: "en" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.resend.com/emails");
    expect(sent[0].auth).toBe("Bearer re_test");
    expect(sent[0].body.to).toEqual(["ann@example.com"]);
    const code = sent[0].body.subject.match(/\d{6}/)[0];
    const r = await call(mail, "POST", "/v1/auth/sessions", session("ann@example.com", code));
    expect(r.status).toBe(201);
  });

  it("K1 sign-in: the first device of a new user has the manage tier, and the credential is stored only as a hash", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    expect(code).toMatch(/^\d{6}$/);
    const r = await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code));
    expect(r.status).toBe(201);
    expect(r.json.device.tier).toBe("manage");
    expect(r.json.device.this_device).toBe(true);
    expect(r.json.user.timezone).toBe(TZ);
    const me = await call(env, "GET", "/v1/devices/me", { token: r.json.credential });
    expect(me.status).toBe(200);
    const rows = await db(env, "SELECT * FROM devices");
    expect(JSON.stringify(rows)).not.toContain(r.json.credential);
    expect(rows[0].credential_hash).toMatch(/^[0-9a-f]{64}$/);
    // The user got the built-in assistant as the default for analysis and digest.
    const settings = await call(env, "GET", "/v1/settings", { token: r.json.credential });
    const assistants = await call(env, "GET", "/v1/assistants", { token: r.json.credential });
    expect(assistants.json.assistants).toHaveLength(1);
    expect(assistants.json.assistants[0].built_in).toBe(true);
    expect(settings.json.roles.analysis).toBe(assistants.json.assistants[0].id);
    expect(settings.json.roles.digest).toBe(assistants.json.assistants[0].id);
    expect(settings.json.roles.deep_read).toBeNull();
  });

  it("K1 sign-in: a code works once", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    expect((await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code))).status).toBe(201);
    const again = await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code));
    expect(again.status).toBe(401);
    expect(again.json.error.code).toBe("unauthorized");
  });

  it("K1 sign-in: a code is valid for 10 minutes", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    advance(10 * MINUTE + 1000);
    expect((await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code))).status).toBe(401);
    const fresh = await loginCode(env, "ann@example.com");
    advance(9 * MINUTE);
    expect((await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", fresh))).status).toBe(201);
  });

  it("K1 sign-in: five wrong tries void the code, even for the right code afterwards", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", wrong))).status).toBe(401);
    expect((await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code))).status).toBe(401);
  });

  it("K1 sign-in: an email that is not invited cannot get a code, not even from the operator", async () => {
    const env = makeEnv();
    const r = await call(env, "POST", "/admin/login-codes", { token: ADMIN, body: { email: "stranger@example.com" } });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_invited");
    expect((await call(env, "POST", "/v1/auth/sessions", session("stranger@example.com", "123456"))).status).toBe(401);
  });

  it("K1 sign-in: every later sign-in of the same user is also a manage device of the same account", async () => {
    const env = makeEnv();
    const first = await signIn(env, "ann@example.com");
    const code = await loginCode(env, "ann@example.com");
    const second = await call(env, "POST", "/v1/auth/sessions", session("ann@example.com", code));
    expect(second.json.user.id).toBe(first.userId);
    expect(second.json.device.tier).toBe("manage");
    expect(await db(env, "SELECT id FROM users")).toHaveLength(1);
  });
});

describe("admin endpoints", () => {
  it("admin: needs the admin secret; answers 404 when no secret is configured", async () => {
    const env = makeEnv();
    expect((await call(env, "GET", "/admin/invites")).status).toBe(401);
    expect((await call(env, "GET", "/admin/invites", { token: "wrong" })).status).toBe(401);
    expect((await call(env, "GET", "/admin/invites", { token: ADMIN })).status).toBe(200);
    const off = makeEnv({ ADMIN_SECRET: undefined });
    expect((await call(off, "GET", "/admin/invites", { token: ADMIN })).status).toBe(404);
    expect((await call(off, "POST", "/admin/login-codes", { token: ADMIN, body: { email: "a@b.co" } })).status).toBe(404);
  });

  it("admin: invites can be added, listed and removed", async () => {
    const env = makeEnv();
    await invite(env, "Ann@Example.com");
    await invite(env, "bob@example.com");
    const list = await call(env, "GET", "/admin/invites", { token: ADMIN });
    expect(list.json.invites.map((i: any) => i.email)).toEqual(["ann@example.com", "bob@example.com"]);
    expect((await call(env, "DELETE", "/admin/invites", { token: ADMIN, body: { email: "bob@example.com" } })).status).toBe(204);
    expect((await call(env, "POST", "/admin/login-codes", { token: ADMIN, body: { email: "bob@example.com" } })).status).toBe(404);
  });
});
