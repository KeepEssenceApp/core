import { describe, expect, it } from "vitest";
import { advance, DAY } from "../src/clock";
import { runMinute } from "../src/cron";
import { isPublicUrl } from "../src/services/fetchpage";
import { ADMIN, call, connectDevice, db, idem, makeEnv, signIn, type Outbound } from "./helpers";

const html = (title: string, body: string, extra = "") =>
  new Response(`<html><head><title>${title}</title>${extra}</head><body><nav><p>Menu Home About</p></nav><article><h1>${title}</h1>${body}</article><script>var x = "junk";</script></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

function pages(map: Record<string, () => Response | Promise<Response>>, seen: string[] = []): Outbound {
  return async (url, init) => {
    seen.push(url);
    const hit = map[url];
    if (!hit) return new Response("not found", { status: 404 });
    return hit();
  };
}

describe("K5 saving", () => {
  it("K5 saving: a link is saved at once and its page is fetched after the answer", async () => {
    const seen: string[] = [];
    const env = makeEnv({
      OUTBOUND: pages({ "https://blog.example.org/tea": () => html("How to brew tea", "<p>Water at 80 degrees works best for green tea.</p><p>Steep for two minutes.</p>", '<meta property="og:site_name" content="The Tea Blog">') }, seen),
    });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://blog.example.org/tea", entry: "toolbar" }, idem: idem() });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "saved", message_key: "saved", message: "Saved." });
    expect(seen).toEqual(["https://blog.example.org/tea"]);
    const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ kind: "link", title: "How to brew tea", site: "The Tea Blog", stage: "saved", content_unavailable: false, days_left: 30, pinned: false });
    expect(item.body).toContain("Water at 80 degrees");
    expect(item.body).not.toContain("junk");
    expect(item.body).not.toContain("Menu Home");
    expect(item.tags).toContain("source:web/toolbar");
  });

  it("K5 saving: text, image and file are saved too; a text without a title takes its first sentence", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const text = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "Green tea likes cooler water. Black tea does not." }, idem: idem() });
    expect(text.status).toBe(201);
    expect((await call(env, "GET", `/v1/items/${text.json.item_id}`, { token: ann.token })).json.title).toBe("Green tea likes cooler water.");
    for (const [kind, type, bytes] of [
      ["image", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])],
      ["file", "application/pdf", new TextEncoder().encode("%PDF-1.7 hello")],
    ] as const) {
      const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const up = await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: sha, bytes: bytes.byteLength, content_type: type } });
      expect(up.json.status).toBe("upload");
      expect((await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": type } })).status).toBe(204);
      expect((await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token })).status).toBe(204);
      const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind, asset_id: up.json.asset_id, title: `My ${kind}` }, idem: idem() });
      expect(saved.status).toBe(201);
      expect(saved.json.image_stored).toBe(true);
      const item = (await call(env, "GET", `/v1/items/${saved.json.item_id}`, { token: ann.token })).json;
      expect(item).toMatchObject({ kind, title: `My ${kind}`, asset_id: up.json.asset_id });
    }
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items).toHaveLength(3);
  });

  it("K5 saving: the Idempotency-Key is required, and the same key replays the first answer without saving again", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const missing = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "One." } });
    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("idempotency_key_required");
    const key = idem();
    const first = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "One." }, idem: key });
    const again = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "Something else entirely." }, idem: key });
    expect(again.status).toBe(201);
    expect(again.json).toEqual(first.json);
    expect(again.headers.get("idempotent-replay")).toBe("true");
    expect(await db(env, "SELECT id FROM items")).toHaveLength(1);
    // After 7 days the key is forgotten.
    advance(7 * DAY + 1000);
    const later = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "One, later." }, idem: key });
    expect(later.json.item_id).not.toBe(first.json.item_id);
  });

  it("K5 saving: the same address saved again is swallowed and the answer says so; after deletion it is a new item", async () => {
    const env = makeEnv({ OUTBOUND: pages({}) });
    const ann = await signIn(env);
    const first = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/a?utm_source=x#top" }, idem: idem() });
    const dup = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/a/" }, idem: idem(), headers: { "accept-language": "zh-CN" } });
    expect(dup.status).toBe(200);
    expect(dup.json).toEqual({ status: "duplicate", item_id: first.json.item_id, message_key: "duplicate", message: "之前存过了，没有重复存。" });
    expect(await db(env, "SELECT id FROM items")).toHaveLength(1);
    await call(env, "DELETE", `/v1/items/${first.json.item_id}`, { token: ann.token });
    const fresh = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/a" }, idem: idem() });
    expect(fresh.status).toBe(201);
    expect(fresh.json.item_id).not.toBe(first.json.item_id);
  });

  it("K5 saving: a request that carries tags or any other unknown field is refused", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    for (const extra of [{ tags: ["assistant:Helper"] }, { expiry_days: 365 }, { dispatch_to: "x" }]) {
      const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "One.", ...extra }, idem: idem() });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("bad_request");
      expect(r.json.error.message).toContain(Object.keys(extra)[0]);
    }
    expect((await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link" }, idem: idem() })).status).toBe(400);
    expect((await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "ftp://example.org/x" }, idem: idem() })).status).toBe(400);
    expect((await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text" }, idem: idem() })).status).toBe(400);
    expect(await db(env, "SELECT id FROM items")).toHaveLength(0);
  });

  it("K5 saving: a save-only device can save and the error message follows Accept-Language", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const saver = await connectDevice(env, ann, "save");
    const ok = await call(env, "POST", "/v1/items", { token: saver.token, body: { kind: "text", text: "From the extension." }, idem: idem(), headers: { "accept-language": "zh" } });
    expect(ok.json.message).toBe("已存入。");
    const bad = await call(env, "POST", "/v1/items", { token: saver.token, body: { kind: "nope" }, idem: idem(), headers: { "accept-language": "zh" } });
    expect(bad.json.error.message).toMatch(/[一-鿿]/);
  });
});

describe("K6 page fetch", () => {
  it("K6 page fetch: private, loopback and link-local addresses are never fetched", () => {
    for (const bad of [
      "http://127.0.0.1/", "http://localhost/admin", "http://10.0.0.8/", "http://192.168.1.1/", "http://172.16.0.1/", "http://169.254.169.254/latest/meta-data",
      "http://[::1]/", "http://[fd00::1]/", "http://[fe80::1]/", "http://[::ffff:10.0.0.1]/", "http://2130706433/", "http://0x7f000001/", "http://intranet/", "http://db.internal/",
      "file:///etc/passwd", "ftp://example.org/", "http://user:pass@example.org/", "http://100.64.0.1/", "http://0.0.0.0/",
    ]) {
      expect(`${bad} ${isPublicUrl(bad)}`).toBe(`${bad} false`);
    }
    expect(isPublicUrl("https://example.org/a")).toBe(true);
    expect(isPublicUrl("http://93.184.216.34/")).toBe(true);
  });

  it("K6 page fetch: a redirect to a non-public address is not followed, and the item says the content could not be fetched", async () => {
    const seen: string[] = [];
    const env = makeEnv({
      OUTBOUND: pages(
        {
          "https://example.org/jump": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } }),
          "http://169.254.169.254/latest/meta-data": () => html("secret", "<p>secret</p>"),
        },
        seen,
      ),
    });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/jump" }, idem: idem() });
    expect(r.status).toBe(201);
    expect(seen).toEqual(["https://example.org/jump"]);
    const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
    expect(item.content_unavailable).toBe(true);
    expect(item.body).toBeNull();
    // Never the raw address as a title: the site name stands in.
    expect(item.title).toBe("example.org");
    expect(item.site).toBe("example.org");
  });

  it("K6 page fetch: at most three redirects are followed", async () => {
    const hop = (n: number) => () => new Response(null, { status: 301, headers: { location: `https://example.org/${n}` } });
    const seen: string[] = [];
    const env = makeEnv({ OUTBOUND: pages({ "https://example.org/0": hop(1), "https://example.org/1": hop(2), "https://example.org/2": hop(3), "https://example.org/3": hop(4), "https://example.org/4": () => html("End", "<p>End.</p>") }, seen) });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/0" }, idem: idem() });
    expect(seen).toHaveLength(4);
    expect((await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json.content_unavailable).toBe(true);
    const ok = makeEnv({ OUTBOUND: pages({ "https://example.org/1": hop(2), "https://example.org/2": hop(3), "https://example.org/3": hop(4), "https://example.org/4": () => html("End", "<p>The end of the road, reached after three redirects and not one more than that.</p>") }) });
    const r2 = await call(ok, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/1" }, idem: idem() });
    expect((await call(ok, "GET", `/v1/items/${r2.json.item_id}`, { token: ann.token })).json).toMatchObject({ title: "End", content_unavailable: false });
  });

  it("K6 page fetch: a page that does not answer in time is given up on (8 seconds by contract; shortened here)", async () => {
    let aborted = false;
    const slow: Outbound = (url, init) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const env = makeEnv({ OUTBOUND: slow, PAGE_FETCH_TIMEOUT_MS: "40" });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://slow.example.org/x", title: "A slow page" }, idem: idem() });
    expect(r.status).toBe(201);
    expect(aborted).toBe(true);
    const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ content_unavailable: true, title: "A slow page" });
    expect((await call(makeEnv(), "GET", "/v1/meta")).json.limits.page_fetch_timeout_seconds).toBe(8);
  });

  it("K6 page fetch: errors, non-HTML answers and empty pages are all 'content could not be fetched'", async () => {
    const env = makeEnv({
      OUTBOUND: pages({
        "https://example.org/500": () => new Response("oops", { status: 500 }),
        "https://example.org/bin": () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/octet-stream" } }),
        "https://example.org/empty": () => new Response("<html><body><script>1</script></body></html>", { headers: { "content-type": "text/html" } }),
      }),
    });
    const ann = await signIn(env);
    for (const path of ["500", "bin", "empty", "missing"]) {
      const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: `https://example.org/${path}` }, idem: idem() });
      const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
      expect(`${path} ${item.content_unavailable}`).toBe(`${path} true`);
    }
  });

  it("K6 page fetch: text the client already sent is kept when the page cannot be fetched", async () => {
    const env = makeEnv({ OUTBOUND: pages({}) });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/paywalled", text: "The selected paragraph about tea." }, idem: idem() });
    const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ content_unavailable: false, body: "The selected paragraph about tea.", title: "The selected paragraph about tea." });
  });

  it("K6 page fetch: an item whose fetch never finished is picked up by cron", async () => {
    const env = makeEnv({ OUTBOUND: pages({ "https://example.org/late": () => html("Late page", "<p>Arrived late, long after the request that saved the link had been answered.</p>") }) });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/late" }, idem: idem() });
    // Pretend the request ended before the fetch did.
    await env.DB.prepare("UPDATE items SET fetch_state = 'pending', title = '', body = NULL WHERE id = ?").bind(r.json.item_id).run();
    advance(61_000);
    await runMinute(env);
    expect((await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json).toMatchObject({ title: "Late page", content_unavailable: false });
  });
});

describe("QA #85–#87: the ways a link's content is read", () => {
  const SHELL = () => html("一个家最好的状态 - rednote", "<p>Explore</p><p>Post</p><p>Notifications</p>");
  const LONG = "这是一篇足够长的正文，用来确认读到的是内容而不是页面的外壳。".repeat(4);
  const admin = (env: any, method: string, path: string, body?: unknown) => call(env, method, path, { token: ADMIN, body });

  it("a page that is only a shell keeps its title, and its words are not taken for content", async () => {
    const env = makeEnv({ OUTBOUND: pages({ "https://www.xiaohongshu.com/explore/1": SHELL }) });
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://www.xiaohongshu.com/explore/1" }, idem: idem() });
    const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ title: "一个家最好的状态 - rednote", content_unavailable: true });
    expect((await db(env, "SELECT body FROM items WHERE id = ?", r.json.item_id))[0].body ?? "").toBe("");
    expect(await db(env, "SELECT platform, path, n FROM fetch_stats")).toEqual([{ platform: "xiaohongshu", path: "none", n: 1 }]);
  });

  it("a reader service is not asked until the operator turns it on; then it is asked after the direct way fails", async () => {
    const asked: { url: string; auth: string | undefined }[] = [];
    const outbound: Outbound = async (url, init) => {
      if (url.startsWith("https://r.jina.ai/")) {
        asked.push({ url, auth: (init?.headers as any)?.authorization });
        return Response.json({ data: { title: "人工智能全球治理", content: LONG } });
      }
      return new Response("verify", { status: 403 });
    };
    const env = makeEnv({ OUTBOUND: outbound });
    const ann = await signIn(env);
    const url = "https://mp.weixin.qq.com/s?__biz=abc&mid=1";
    const first = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url }, idem: idem() });
    expect(asked).toHaveLength(0);
    expect((await call(env, "GET", `/v1/items/${first.json.item_id}`, { token: ann.token })).json.content_unavailable).toBe(true);

    const put = await admin(env, "PUT", "/admin/fetch", { jina: { enabled: true, key: "aaaaaaaaaaaa1234" } });
    expect(put.status).toBe(200);
    expect(put.json.jina).toEqual({ enabled: true, endpoint: "", key_set: true, key_hint: "…1234" });
    expect(put.text).not.toContain("aaaaaaaaaaaa");
    const second = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: url + "&x=2" }, idem: idem() });
    expect(asked).toEqual([{ url: `https://r.jina.ai/${url}&x=2`, auth: "Bearer aaaaaaaaaaaa1234" }]);
    expect((await call(env, "GET", `/v1/items/${second.json.item_id}`, { token: ann.token })).json).toMatchObject({ title: "人工智能全球治理", content_unavailable: false });
    const view = (await admin(env, "GET", "/admin/fetch")).json;
    expect(view.stats.rows).toEqual([{ platform: "wechat", path: "jina", n: 1 }, { platform: "wechat", path: "none", n: 1 }]);
    // The key never comes back, and the audit entry does not hold it.
    expect(JSON.stringify(view)).not.toContain("aaaaaaaaaaaa");
    expect((await admin(env, "GET", "/admin/audit")).text).not.toContain("aaaaaaaaaaaa");
    expect((await admin(env, "GET", "/admin/audit")).json.entries[0]).toMatchObject({ action: "fetch.settings", detail: "jina on; jina key set" });
  });

  it("the order can be changed, the settings are checked, and a test read says how it went without keeping what it read", async () => {
    const outbound: Outbound = async (url) => {
      if (url === "https://api.firecrawl.dev/v1/scrape") return Response.json({ success: true, data: { markdown: LONG, metadata: { title: "From firecrawl" } } });
      if (url.startsWith("https://reader.example.net/")) return Response.json({ data: { title: "", content: "short" } });
      return html("Direct", `<p>${LONG}</p>`);
    };
    const env = makeEnv({ OUTBOUND: outbound });
    expect((await admin(env, "PUT", "/admin/fetch", { order: ["firecrawl", "direct"] })).status).toBe(400);
    expect((await admin(env, "PUT", "/admin/fetch", { jina: { endpoint: "http://reader.example.net" } })).status).toBe(400);
    expect((await admin(env, "PUT", "/admin/fetch", { jina: { endpoint: "https://user:pw@reader.example.net" } })).status).toBe(400);
    const set = await admin(env, "PUT", "/admin/fetch", { order: ["firecrawl", "jina", "direct"], firecrawl: { enabled: true }, jina: { enabled: true, endpoint: "https://reader.example.net/" } });
    expect(set.json.order).toEqual(["firecrawl", "jina", "direct"]);
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/a" }, idem: idem() });
    expect((await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json.title).toBe("From firecrawl");

    const bad = await admin(env, "POST", "/admin/fetch/test", { provider: "jina", url: "https://example.org/a" });
    expect(bad.json).toMatchObject({ provider: "jina", ok: false, chars: 5, error: "only a page shell came back" });
    const good = await admin(env, "POST", "/admin/fetch/test", { provider: "direct", url: "https://example.org/a" });
    expect(good.json).toMatchObject({ provider: "direct", ok: true, title: "Direct" });
    expect((await admin(env, "POST", "/admin/fetch/test", { provider: "direct", url: "http://127.0.0.1/x" })).status).toBe(400);
    const view = (await admin(env, "GET", "/admin/fetch")).json;
    expect(view.tests.jina).toMatchObject({ ok: false, url_host: "example.org" });
    expect(view.tests.direct).toMatchObject({ ok: true, url_host: "example.org" });
    expect(JSON.stringify(view)).not.toContain(LONG.slice(0, 12));
  });
});
