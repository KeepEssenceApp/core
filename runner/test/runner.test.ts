// QA #101: the runner, end to end with a real browser. Fabricated pages only. The made-up network is a
// local server behind the proxy (see helpers.ts); the proxy's rules run for real.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { article, canary, hasOpenssl, KEY, page, redirect, reply, start, TEA, WALL, type Options, type Routes, type Started } from "./helpers.ts";

let running: Started | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});
const run = async (routes: Routes, opts?: Options) => (running = await start(routes, opts));
/** The pages asked for, not the browser's favicon, styles or scripts. */
const docs = (s: Started) => s.hits.filter((h) => !/\.(css|js|ico)$/.test(h.url));
const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

describe("the interface", () => {
  it("answers the way Jina Reader does: { data: { title, content } }, asking as a desktop browser, Chinese first", async () => {
    const s = await run({ "http://blog.example.org/tea": () => article() });
    const r = await s.read("http://blog.example.org/tea");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "How to brew tea");
    assert.equal(r.json.data.url, "http://blog.example.org/tea");
    assert.ok(r.json.data.content.includes("Steep green tea"));
    assert.deepEqual(docs(s).map((h) => `${h.ua} ${h.url}`), ["desktop http://blog.example.org/tea"]);
    // The browser's own list (zh-CN first, as the direct read's), written the way the browser writes it.
    assert.match(docs(s)[0].lang ?? "", /^zh-CN,zh/);
  });

  it("wants the key: no key, a wrong key and a near miss are 401; the health check needs none and says nothing", async () => {
    const s = await run({});
    for (const key of [null, "", "wrong", KEY.slice(0, -1), KEY + "x"]) assert.equal((await s.read("http://blog.example.org/tea", key)).status, 401, String(key));
    const health = await fetch(`${s.base}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
    assert.equal(s.hits.length, 0);
  });

  it("says what is wrong with a request that is not an address, or not a GET", async () => {
    const s = await run({});
    assert.equal((await s.read("not-an-address")).status, 400);
    assert.equal((await s.read("ftp://example.org/x")).status, 400);
    assert.equal((await s.read("http://127.0.0.1:9/")).status, 400);
    assert.equal((await s.read("http://169.254.169.254/latest/meta-data")).status, 400);
    const post = await fetch(`${s.base}/http://blog.example.org/tea`, { method: "POST", headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(post.status, 405);
    assert.equal(s.hits.length, 0);
  });

  it("takes the address with its slashes merged by a proxy (http:/host/...) too", async () => {
    const s = await run({ "http://blog.example.org/tea?x=1": () => article() });
    const res = await fetch(`${s.base}/http:/blog.example.org/tea?x=1`, { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(res.status, 200);
  });

  it("refuses to start without a key of some length", async () => {
    const { loadConfig } = await import("../src/config.ts");
    assert.throws(() => loadConfig({}), /RUNNER_KEY/);
    assert.throws(() => loadConfig({ RUNNER_KEY: "short" }), /RUNNER_KEY/);
  });
});

describe("the rules are the core's (#100)", () => {
  it("a wall on the desktop goes on to the iPhone, and what the wall said is never returned", async () => {
    const s = await run({ "http://blog.example.org/walled": (hit) => (hit.ua === "desktop" ? WALL() : article("An article for phones")) });
    const r = await s.read("http://blog.example.org/walled");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "An article for phones");
    assert.deepEqual(docs(s).map((h) => h.ua), ["desktop", "iphone"]);
    assert.ok(!JSON.stringify(r.json).includes("环境异常"));
  });

  it("a refusal (403) goes on to the next User-Agent too; both walled is 422 with the reason and not a word of the wall", async () => {
    const s = await run({ "http://mp.weixin.qq.com/s?__biz=abc": () => WALL(), "http://blog.example.org/403": () => reply("no", 403) });
    const wall = await s.read("http://mp.weixin.qq.com/s?__biz=abc");
    assert.equal(wall.status, 422);
    assert.equal(wall.json.error, "wall");
    assert.ok(!JSON.stringify(wall.json).includes("当前环境异常"));
    assert.ok(!JSON.stringify(wall.json).includes("Weixin"));
    assert.equal(docs(s).filter((h) => h.url.includes("weixin")).length, 2);
    const refused = await s.read("http://blog.example.org/403");
    assert.equal(refused.status, 422);
    assert.equal(docs(s).filter((h) => h.url.endsWith("/403")).length, 2);
  });

  it("the apps that want a phone are asked as one first", async () => {
    const s = await run({ "http://www.xiaohongshu.com/explore/1": () => article(), "http://notxiaohongshu.com/explore/1": () => article() });
    await s.read("http://www.xiaohongshu.com/explore/1");
    await s.read("http://notxiaohongshu.com/explore/1");
    assert.deepEqual(docs(s).map((h) => `${h.ua} ${new URL(h.url).hostname}`), ["iphone www.xiaohongshu.com", "desktop notxiaohongshu.com"]);
  });

  it("a shell is not content: a WeChat article with only the page's words, and a column of buttons, are 422", async () => {
    const chrome = ["微信扫一扫关注该公众号", "继续滑动看下一个", "轻触阅读原文", "向上滑动看下一个", "当前内容无法在此显示，请使用微信客户端打开", "点击下方按钮在微信中查看完整文章内容", "小程序", "赞", "在看", "分享", "留言", "收藏"];
    const buttons = ["Like", "Share", "Save", "Reply", "Menu", "Home", "Top", "More", "Next", "Prev", "Help", "Login", "Print", "Copy", "Edit", "Back", "Send", "Open"];
    const s = await run({
      "http://mp.weixin.qq.com/s?__biz=shell": () => page("一篇关于松木家具保养的文章", chrome.map((l) => `<p>${l}</p>`).join("")),
      "http://app.example.org/buttons": () => page("Pine team report", buttons.map((l) => `<p>${l}</p>`).join("")),
    });
    for (const url of ["http://mp.weixin.qq.com/s?__biz=shell", "http://app.example.org/buttons"]) {
      const r = await s.read(url);
      assert.equal(`${url} ${r.status} ${r.json.error}`, `${url} 422 thin`);
      assert.equal(r.json.data, undefined);
    }
  });

  it("a short post on a site of short posts is its description", async () => {
    const caption = "周末在家把阳台收拾了一遍，种了薄荷、罗勒和小番茄，晚上泡了一杯薄荷茶，邻居也来坐了一会儿。";
    const post = () => page("阳台上的薄荷", "<p>Explore</p><p>Post</p><p>Notifications</p>", `<meta property="og:description" content="${caption}">`);
    const s = await run({ "http://www.xiaohongshu.com/explore/2": post, "http://blog.example.org/explore/2": post });
    const ok = await s.read("http://www.xiaohongshu.com/explore/2");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.content, caption);
    assert.equal((await s.read("http://blog.example.org/explore/2")).status, 422);
  });

  it("a title that is a login page's is not given", async () => {
    const s = await run({ "http://blog.example.org/a": () => article("登录 - 知乎") });
    const r = await s.read("http://blog.example.org/a");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "");
  });

  it("follows a redirect to a public address, and the rules judge the page it ended on", async () => {
    const s = await run({ "http://short.example.org/a": () => redirect("http://blog.example.org/tea"), "http://blog.example.org/tea": () => article() });
    const r = await s.read("http://short.example.org/a");
    assert.equal(r.status, 200);
    assert.deepEqual(docs(s).map((h) => new URL(h.url).hostname), ["short.example.org", "blog.example.org"]);
  });
});

describe("the browser keeps its own network stack, behind the proxy", () => {
  it("an https page is read through a tunnel, and the browser's own HTTP/2 comes through it", { skip: !hasOpenssl && "openssl is needed to make a test certificate" }, async () => {
    const s = await run({ "https://secure.example.org/tea": () => article("Over TLS") }, { tls: true });
    const r = await s.read("https://secure.example.org/tea");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.title, "Over TLS");
    // The proxy only tunnelled: the handshake and the protocol are Chromium's own, which is what a site that looks at them sees.
    assert.equal(docs(s)[0].httpVersion, "2.0");
  });
});

describe("the page cannot reach this machine's network", () => {
  it("a page that asks for localhost, 127.0.0.1, the LAN, the metadata address or a WebSocket on this machine gets nothing, and still reads", async () => {
    const own = await canary();
    try {
      const asks = `
        fetch("http://127.0.0.1:${own.port}/a").catch(() => {});
        fetch("http://localhost:${own.port}/b").catch(() => {});
        fetch("http://169.254.169.254/latest/meta-data").catch(() => {});
        fetch("http://192.168.0.1/").catch(() => {});
        fetch("http://[::1]:${own.port}/c").catch(() => {});
        const i = document.createElement("iframe"); i.src = "http://127.0.0.1:${own.port}/d"; document.body.appendChild(i);
        const s = document.createElement("script"); s.src = "http://localhost:${own.port}/e.js"; document.body.appendChild(s);
        try { new WebSocket("ws://127.0.0.1:${own.port}/ws"); } catch {}
        try { new WebSocket("ws://localhost:${own.port}/ws"); } catch {}
        const x = new XMLHttpRequest(); x.open("GET", "http://127.0.0.1:${own.port}/f"); try { x.send(); } catch {}`;
      const s = await run({ "http://blog.example.org/nosy": () => page("Nosy page", `<article><p>${TEA}</p><p>${TEA}</p></article><script>${asks}</script>`) });
      const ok = await s.read("http://blog.example.org/nosy");
      assert.equal(ok.status, 200);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(own.hits(), 0, "this machine's own network was reached");
      assert.ok(!s.hits.some((h) => /169\.254|192\.168|localhost|127\.0\.0\.1/.test(h.url)));
    } finally {
      own.close();
    }
  });

  it("a name that leads to a private address is refused when connecting", async () => {
    const s = await run(
      { "http://blog.example.org/lan": () => page("Names", `<article><p>${TEA}</p><p>${TEA}</p></article><script>fetch("http://internal.example.org/secret").catch(() => {}); fetch("http://internal.example.org:80/again").catch(() => {});</script>`), "http://internal.example.org/secret": () => reply("secret") },
      { privateNames: ["internal.example.org"] },
    );
    assert.equal((await s.read("http://blog.example.org/lan")).status, 200);
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(!s.hits.some((h) => h.url.includes("internal.example.org")));
    // As the address of the read itself it is an error, and nothing was asked of it.
    const direct = await s.read("http://internal.example.org/secret");
    assert.equal(direct.status, 502);
    assert.ok(!s.hits.some((h) => h.url.includes("internal.example.org")));
  });

  it("a redirect to a private address is not followed, and neither is a script's", async () => {
    const s = await run({
      "http://example.org/jump": () => redirect("http://169.254.169.254/latest/meta-data"),
      "http://blog.example.org/scripted": () => page("Scripted", `<article><p>${TEA}</p><p>${TEA}</p></article><script src="http://static.example.org/a.js"></script>`),
      "http://static.example.org/a.js": () => redirect("http://192.168.0.1/a.js"),
    });
    const jump = await s.read("http://example.org/jump");
    assert.equal(jump.status, 502);
    assert.equal(jump.json.error, "error");
    assert.equal((await s.read("http://blog.example.org/scripted")).status, 200);
    assert.ok(!s.hits.some((h) => /169\.254|192\.168/.test(h.url)));
  });

  it("pictures, sound and fonts are not asked for; scripts and styles of a public page are", async () => {
    const s = await run({
      "http://blog.example.org/rich": () =>
        page("Rich page", `<article><p>${TEA}</p><p>${TEA}</p><img src="http://cdn.example.org/a.png"><video src="http://cdn.example.org/a.mp4"></video></article>`, '<link rel="stylesheet" href="http://static.example.org/a.css"><style>@font-face{font-family:x;src:url(http://cdn.example.org/f.woff2)}p{font-family:x}</style>'),
      "http://static.example.org/a.css": () => reply("p { color: #222 }", 200, { "content-type": "text/css" }),
    });
    assert.equal((await s.read("http://blog.example.org/rich")).status, 200);
    const asked = s.hits.map((h) => h.url);
    assert.ok(asked.includes("http://static.example.org/a.css"));
    for (const never of ["a.png", "a.mp4", "f.woff2"]) assert.ok(!asked.some((u) => u.endsWith(never)), never);
  });
});

describe("a runner that is slow, busy or down never holds anything up", () => {
  it("a page that does not answer is 504 within the one deadline, and nothing is left open: no read, no connection", async () => {
    const s = await run({ "http://slow.example.org/x": () => "hang" }, { env: { RUNNER_DEADLINE_MS: "1500" } });
    const started = Date.now();
    const r = await s.read("http://slow.example.org/x");
    const took = Date.now() - started;
    assert.equal(r.status, 504);
    assert.ok(took < 4000, `took ${took} ms`);
    // The two User-Agents share the one deadline: one request was made, not two budgets' worth.
    assert.equal(docs(s).length, 1);
    assert.ok(await until(() => s.proxy.openReads() === 0 && s.open() === 0), `left over: ${s.proxy.openReads()} reads, ${s.open()} connections`);
  });

  it("a page that is larger than the read may be is cut off, and what it had read so far is not mistaken for the whole", async () => {
    let cut = false;
    const s = await run(
      {
        "http://big.example.org/a": () => page("Big", `<article><p>${TEA}</p><p>${TEA}</p></article><script src="http://big.example.org/big.js"></script>`),
        "http://big.example.org/big.js": () => (res) => {
          res.on("close", () => {
            cut = !res.writableFinished;
          });
          res.writeHead(200, { "content-type": "text/javascript" });
          const chunk = Buffer.alloc(64 * 1024, "a");
          const send = () => {
            for (let i = 0; i < 400 && !res.destroyed; i++) if (!res.write(chunk)) return void res.once("drain", send);
            res.end();
          };
          send();
        },
      },
      { env: { RUNNER_MAX_BYTES: "300000" } },
    );
    const r = await s.read("http://big.example.org/a");
    assert.ok([200, 502, 504].includes(r.status), String(r.status));
    assert.ok(await until(() => cut), "the large file was not cut off");
    assert.ok(await until(() => s.proxy.openReads() === 0 && s.open() === 0));
  });

  it("when the pages and the queue are full the answer is 503 at once", async () => {
    const s = await run({ "http://slow.example.org/x": () => "hang" }, { env: { RUNNER_DEADLINE_MS: "2500", RUNNER_CONCURRENCY: "1", RUNNER_QUEUE: "1" } });
    const first = s.read("http://slow.example.org/x");
    const second = s.read("http://slow.example.org/x");
    await new Promise((r) => setTimeout(r, 400));
    const started = Date.now();
    const third = await s.read("http://slow.example.org/x");
    assert.equal(third.status, 503);
    assert.ok(Date.now() - started < 1000);
    assert.deepEqual((await Promise.all([first, second])).map((r) => r.status), [504, 504]);
  });

  it("the Chromium that died is started again on the next read", async () => {
    const s = await run({ "http://blog.example.org/tea": () => article() });
    assert.equal((await s.read("http://blog.example.org/tea")).status, 200);
    await s.renderer.close();
    assert.equal((await s.read("http://blog.example.org/tea")).status, 200);
  });
});

describe("what is logged", () => {
  it("that a read happened, how it went and how long: never an address, a name, a word of the page or the key", async () => {
    const s = await run({ "http://blog.example.org/tea": () => article("A very private title"), "http://mp.weixin.qq.com/s?__biz=secret123": () => WALL() });
    await s.read("http://blog.example.org/tea");
    await s.read("http://mp.weixin.qq.com/s?__biz=secret123");
    await s.read("http://blog.example.org/tea", "wrong");
    const text = s.logs.join("\n");
    assert.equal(s.logs.length, 2);
    for (const never of ["blog.example.org", "secret123", "private", "Steep", "weixin", "环境", KEY, "wrong"]) assert.ok(!text.includes(never), never);
    assert.deepEqual(s.logs.map((l) => [JSON.parse(l).result, JSON.parse(l).platform]), [["ok", "other"], ["wall", "wechat"]]);
  });
});
