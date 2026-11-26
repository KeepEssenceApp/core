// QA #100: the direct read, end to end. Every page here is made up; no real user's text or address.
// The rules themselves are in pagerules.test.ts; this is what the core does with them: which
// requests it makes, what it stores, and what it never stores.
import { describe, expect, it } from "vitest";
import { ADMIN, call, db, idem, makeEnv, signIn, type Outbound } from "./helpers";

type Ask = { url: string; ua: "desktop" | "iphone"; lang: string | undefined };

/** Answers each request, and writes down what was asked for and with which User-Agent. */
function asking(asked: Ask[], answer: (url: string, ua: Ask["ua"]) => Response | Promise<Response>): Outbound {
  return async (url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const ua = h["user-agent"]?.includes("iPhone") ? "iphone" : "desktop";
    asked.push({ url, ua, lang: h["accept-language"] });
    return answer(url, ua);
  };
}

const page = (title: string, body: string, head = "") =>
  new Response(`<html><head><title>${title}</title>${head}</head><body>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

const TEA = "Steep green tea for two minutes in water of about eighty degrees, and taste it before the second cup, because the leaves give more each time they are steeped.";
const article = (title = "How to brew tea") => page(title, `<p>${TEA}</p><p>${TEA}</p>`);
const WALL_TITLE = "Weixin Official Accounts Platform";
const WALL_LINES = ["环境异常", "当前环境异常，完成验证后即可继续访问，请点击下面的按钮，按照页面的提示完成安全验证，验证通过之后页面会自动刷新并回到你要看的内容。", "去验证"];
const wall = () => page(WALL_TITLE, WALL_LINES.map((l) => `<p>${l}</p>`).join(""));

async function read(env: ReturnType<typeof makeEnv>, ann: { token: string }, url: string, extra: Record<string, unknown> = {}) {
  const r = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url, ...extra }, idem: idem() });
  expect(r.status).toBe(201);
  const item = (await call(env, "GET", `/v1/items/${r.json.item_id}`, { token: ann.token })).json;
  const [row] = await db(env, "SELECT body, title, title_from FROM items WHERE id = ?", r.json.item_id);
  return { item, body: (row.body ?? "") as string, from: row.title_from as string };
}

describe("QA #100: the User-Agents, their order, and when the next one is tried", () => {
  it("asks as a desktop browser first, with Accept-Language; a page that answers well is the only request", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, () => article()) });
    const ann = await signIn(env);
    const { item } = await read(env, ann, "https://blog.example.org/tea");
    expect(asked).toEqual([{ url: "https://blog.example.org/tea", ua: "desktop", lang: "zh-CN,zh;q=0.9,en;q=0.8" }]);
    expect(item).toMatchObject({ title: "How to brew tea", content_unavailable: false });
  });

  it("a verification wall makes the iPhone go next; its content is kept and the wall's words are never stored", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, (_, ua) => (ua === "desktop" ? wall() : article("An article for phones"))) });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://blog.example.org/walled-for-desktops");
    expect(asked.map((a) => a.ua)).toEqual(["desktop", "iphone"]);
    expect(asked.every((a) => a.url === "https://blog.example.org/walled-for-desktops" && a.lang === "zh-CN,zh;q=0.9,en;q=0.8")).toBe(true);
    expect(item).toMatchObject({ title: "An article for phones", content_unavailable: false });
    expect(body).toContain("Steep green tea");
    for (const w of [...WALL_LINES, WALL_TITLE]) expect(body).not.toContain(w);
  });

  it("a site that refuses the client (403, 429) gets the other User-Agent too; an ordinary error (404, 500) does not", async () => {
    for (const [status, attempts] of [[403, 2], [429, 2], [401, 2], [503, 2], [404, 1], [500, 1], [410, 1]] as const) {
      const asked: Ask[] = [];
      const env = makeEnv({ OUTBOUND: asking(asked, () => new Response("no", { status })) });
      const ann = await signIn(env);
      const { item } = await read(env, ann, `https://blog.example.org/${status}`);
      expect(`${status} ${asked.length}`).toBe(`${status} ${attempts}`);
      expect(item.content_unavailable).toBe(true);
    }
  });

  it("the apps that want a phone are asked as one first; a look-alike host or an address that only mentions an app is not one", async () => {
    const cases: [string, Ask["ua"]][] = [
      ["https://www.xiaohongshu.com/explore/1", "iphone"],
      ["https://zhuanlan.zhihu.com/p/1", "iphone"],
      ["https://m.weibo.cn/status/3", "iphone"],
      ["https://notxiaohongshu.com/explore/1", "desktop"],
      ["https://xiaohongshu.com.example.org/explore/1", "desktop"],
      ["https://example.org/post?from=zhihu.com", "desktop"],
      ["https://example.org/weibo.cn/status/3", "desktop"],
      ["https://mp.weixin.qq.com/s?__biz=abc&mid=1", "desktop"],
    ];
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, () => article()) });
    const ann = await signIn(env);
    for (const [url, first] of cases) {
      asked.length = 0;
      await read(env, ann, url);
      expect(`${url} ${asked[0]?.ua} ${asked.length}`).toBe(`${url} ${first} 1`);
    }
  });

  it("when both are walled the content is 'not fetched', after two requests and no more", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, () => wall()) });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://mp.weixin.qq.com/s?__biz=abc&mid=2");
    expect(asked.map((a) => a.ua)).toEqual(["desktop", "iphone"]);
    expect(item).toMatchObject({ content_unavailable: true, body: null });
    expect(body).toBe("");
    expect((await db(env, "SELECT platform, path, n FROM fetch_stats"))).toEqual([{ platform: "wechat", path: "none", n: 1 }]);
  });
});

describe("QA #100: a wall is not content, and its title is not the item's title", () => {
  it("the text of a wall longer than 60 characters is not content, and the item keeps the title it had", async () => {
    expect(WALL_LINES.join("").length).toBeGreaterThan(60);
    const env = makeEnv({ OUTBOUND: asking([], () => wall()) });
    const ann = await signIn(env);
    const shared = await read(env, ann, "https://mp.weixin.qq.com/s?__biz=abc&mid=3", { title: "松木团队的三页报告" });
    expect(shared.item).toMatchObject({ title: "松木团队的三页报告", content_unavailable: true });
    expect(shared.from).toBe("client");
    expect(shared.body).toBe("");
    // Nothing was shared with it: the host name stands in, never the wall's own title.
    const bare = await read(env, ann, "https://mp.weixin.qq.com/s?__biz=abc&mid=4");
    expect(bare.item).toMatchObject({ title: "mp.weixin.qq.com", content_unavailable: true });
    expect(bare.item.title).not.toContain("Weixin");
    expect(bare.item.title).not.toContain("环境异常");
    expect(bare.from).toBe("derived");
  });

  it("a wall found in the markup of a short page (a noscript line) counts; the same words low down in a long article do not", async () => {
    const cloudflare = () => page("Please wait", "<p>Checking your browser before you continue to the page you asked for.</p>", "<noscript><p>Enable JavaScript and cookies to continue</p></noscript>");
    const env = makeEnv({ OUTBOUND: asking([], (url) => (url.endsWith("/challenge") ? cloudflare() : page("Troubleshooting sign-in", `${`<p>${TEA}</p>`.repeat(5)}<p>If a site asks you to 完成验证 first, follow its steps and come back.</p>`)) ) });
    const ann = await signIn(env);
    const walled = await read(env, ann, "https://shop.example.org/challenge");
    expect(walled.item).toMatchObject({ content_unavailable: true, title: "shop.example.org" });
    const long = await read(env, ann, "https://shop.example.org/help");
    expect(long.item).toMatchObject({ content_unavailable: false, title: "Troubleshooting sign-in" });
    expect(long.body).toContain("完成验证");
  });

  it("the admin's test read says a page refused it, without keeping what it said", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => wall()) });
    const r = await call(env, "POST", "/admin/fetch/test", { token: ADMIN, body: { provider: "direct", url: "https://mp.weixin.qq.com/s?__biz=abc&mid=5" } });
    expect(r.json).toMatchObject({ provider: "direct", ok: false, chars: 0 });
    expect(r.json.error).toMatch(/refused the read/);
    // The reason names the wall word that was found, never the page's own words.
    expect(JSON.stringify(r.json)).not.toContain(WALL_LINES[1]);
    expect(JSON.stringify(r.json)).not.toContain(WALL_TITLE);
    expect(r.json.title).toBe("");
  });
});

describe("QA #100: a shell is not content", () => {
  it("a WeChat article that came back as the page's own words keeps the title the page gave, and its words are not content", async () => {
    const chrome = ["微信扫一扫关注该公众号", "继续滑动看下一个", "轻触阅读原文", "向上滑动看下一个", "当前内容无法在此显示，请使用微信客户端打开", "点击下方按钮在微信中查看完整文章内容", "小程序", "赞", "在看", "分享", "留言", "收藏"];
    const env = makeEnv({ OUTBOUND: asking([], () => page("一篇关于松木家具保养的文章", chrome.map((l) => `<p>${l}</p>`).join(""))) });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://mp.weixin.qq.com/s?__biz=abc&mid=6");
    expect(item).toMatchObject({ title: "一篇关于松木家具保养的文章", content_unavailable: true, body: null });
    expect(body).toBe("");
  });

  it("a column of buttons is a shell even when it is longer than 60 characters", async () => {
    const buttons = ["Like", "Share", "Save", "Reply", "Menu", "Home", "Top", "More", "Next", "Prev", "Help", "Login", "Print", "Copy", "Edit", "Back", "Send", "Open"];
    const env = makeEnv({ OUTBOUND: asking([], () => page("Pine team report", buttons.map((l) => `<p>${l}</p>`).join(""))) });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://app.example.org/view/9");
    expect(item).toMatchObject({ title: "Pine team report", content_unavailable: true, body: null });
    expect(body).toBe("");
  });

  it("a Channels share page whose shell holds only scripts is a shell", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => page("视频号", '<script>window.__INIT__ = {"feed":"abc"};</script>')) });
    const ann = await signIn(env);
    const { item } = await read(env, ann, "https://weixin.qq.com/sph/AbCdEf");
    expect(item).toMatchObject({ content_unavailable: true, body: null });
  });

  it("example.com is read as before", async () => {
    const env = makeEnv({
      OUTBOUND: asking([], () => page("Example Domain", "<div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href=\"https://www.iana.org/domains/example\">More information...</a></p></div>")),
    });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://example.com/");
    expect(item).toMatchObject({ title: "Example Domain", content_unavailable: false });
    expect(body).toContain("illustrative examples");
  });
});

describe("QA #100: a short post is its caption; under 60 characters stays rejected everywhere else", () => {
  const CAPTION = "周末在家把阳台收拾了一遍，种了薄荷、罗勒和小番茄，晚上泡了一杯薄荷茶，邻居也来坐了一会儿。";
  const withCaption = (caption = CAPTION) => page("阳台上的薄荷", "<p>Explore</p><p>Post</p><p>Notifications</p>", `<meta property="og:description" content="${caption}">`);

  it("on a site of short posts the description is read as the post's text", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => withCaption()) });
    const ann = await signIn(env);
    const { item, body } = await read(env, ann, "https://www.xiaohongshu.com/explore/2");
    expect(item).toMatchObject({ title: "阳台上的薄荷", content_unavailable: false });
    expect(body).toBe(CAPTION);
    expect(body).not.toContain("Notifications");
    expect(await db(env, "SELECT platform, path, n FROM fetch_stats")).toEqual([{ platform: "xiaohongshu", path: "direct", n: 1 }]);
  });

  it("the same page on another site, a look-alike host, or with a description under 40 characters is not content", async () => {
    const env = makeEnv({ OUTBOUND: asking([], (url) => (url.includes("tiny") ? withCaption("太短的一句话。") : withCaption())) });
    const ann = await signIn(env);
    for (const url of ["https://blog.example.org/explore/2", "https://notxiaohongshu.com/explore/2", "https://www.xiaohongshu.com/explore/tiny"]) {
      const { item, body } = await read(env, ann, url);
      expect(`${url} ${item.content_unavailable} ${JSON.stringify(body)}`).toBe(`${url} true ""`);
    }
  });
});

describe("QA #100: titles", () => {
  it("a login, error or address title, or only the site's name, is not used: the first sentence of the text stands in", async () => {
    const env = makeEnv({
      OUTBOUND: asking([], (url) => {
        const title = new URL(url).searchParams.get("t") ?? "";
        const site = '<meta property="og:site_name" content="The Tea Blog">';
        return page(title, `<p>Green tea likes cooler water. ${TEA}</p><p>${TEA}</p>`, site);
      }),
    });
    const ann = await signIn(env);
    for (const t of ["登录 - 知乎", "404 Not Found", "https://blog.example.org/tea", "The Tea Blog", "Access denied"]) {
      const { item } = await read(env, ann, `https://blog.example.org/tea?t=${encodeURIComponent(t)}`);
      expect(`${t} => ${item.title}`).toBe(`${t} => Green tea likes cooler water.`);
    }
    // A title that only starts like one of those is a title.
    expect((await read(env, ann, `https://blog.example.org/tea?t=${encodeURIComponent("Error handling in Rust")}`)).item.title).toBe("Error handling in Rust");
  });

  it("a title the client sent is kept, whatever the page says; a page title that is shorter and contained does not replace a derived one", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => article("Tea")) });
    const ann = await signIn(env);
    const shared = await read(env, ann, "https://blog.example.org/a", { title: "Notes on brewing tea at home" });
    expect(shared.item.title).toBe("Notes on brewing tea at home");
    expect(shared.from).toBe("client");
    // Text without a title: the first sentence is the item's title; "Tea" is only a piece of it.
    const text = await read(env, ann, "https://blog.example.org/b", { text: "Tea is best brewed slowly. The rest of the note is about cups." });
    expect(text.item.title).toBe("Tea is best brewed slowly.");
  });
});

describe("QA #100: the address is checked before every attempt, and one deadline covers them all", () => {
  it("a redirect to a private address is not followed by either User-Agent; the second User-Agent is not asked after it", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({
      OUTBOUND: asking(asked, (url, ua) => {
        if (url === "https://example.org/start") return ua === "desktop" ? new Response("no", { status: 403 }) : new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
        return article("secret");
      }),
    });
    const ann = await signIn(env);
    const { item } = await read(env, ann, "https://example.org/start");
    // Desktop refused; the iPhone was sent to a private address, which was never asked for.
    expect(asked).toEqual([
      { url: "https://example.org/start", ua: "desktop", lang: expect.any(String) },
      { url: "https://example.org/start", ua: "iphone", lang: expect.any(String) },
    ]);
    expect(item).toMatchObject({ content_unavailable: true, title: "example.org" });
  });

  it("each attempt follows at most three redirects of its own, and each hop is checked", async () => {
    const asked: Ask[] = [];
    const hop = (n: number) => new Response(null, { status: 301, headers: { location: `https://example.org/${n}` } });
    const env = makeEnv({
      OUTBOUND: asking(asked, (url, ua) => {
        const n = Number(new URL(url).pathname.slice(1));
        if (ua === "desktop") return n < 2 ? hop(n + 1) : new Response("no", { status: 403 }); // wall after two hops
        return n < 3 ? hop(n + 1) : article("Reached on the phone");
      }),
    });
    const ann = await signIn(env);
    const { item } = await read(env, ann, "https://example.org/0");
    expect(asked.map((a) => `${a.ua}:${new URL(a.url).pathname}`)).toEqual(["desktop:/0", "desktop:/1", "desktop:/2", "iphone:/0", "iphone:/1", "iphone:/2", "iphone:/3"]);
    expect(item).toMatchObject({ title: "Reached on the phone", content_unavailable: false });
  });

  it("the User-Agents share the one deadline: a second attempt does not get a fresh 8 seconds", async () => {
    let started = 0;
    let secondEnded = 0;
    const slow: Outbound = (url, init) => {
      const ua = (init?.headers as Record<string, string>)["user-agent"].includes("iPhone") ? "iphone" : "desktop";
      if (ua === "desktop") return new Promise((resolve) => setTimeout(() => resolve(new Response("no", { status: 403 })), 140));
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          secondEnded = Date.now();
          reject(new Error("aborted"));
        });
      });
    };
    const env = makeEnv({ OUTBOUND: slow, PAGE_FETCH_TIMEOUT_MS: "200" });
    const ann = await signIn(env);
    started = Date.now();
    const { item } = await read(env, ann, "https://slow.example.org/x", { title: "A slow page" });
    expect(item).toMatchObject({ content_unavailable: true, title: "A slow page" });
    expect(secondEnded).toBeGreaterThan(0);
    // 140 ms for the first, then what is left of 200 ms: about 200 ms after the start, not 340.
    expect(secondEnded - started).toBeLessThan(300);
  });
});

describe("QA #103: a Xiaohongshu short link, and the sign-in page it can end on", () => {
  const SIGN_IN = "https://www.rednote.com/login?redirectPath=https%3A%2F%2Fwww.xiaohongshu.com%2Fdiscovery%2Fitem%2F6aa2";
  const LOGIN_LINES = ["登录", "使用 Google 账号登录", "Continue with Google", "使用 Apple 账号登录", "使用手机号或扫码登录", "登录即表示你同意用户协议和隐私政策"];
  const loginPage = () => page("登录 - rednote - share, connect, love", LOGIN_LINES.map((l) => `<p>${l}</p>`).join(""), '<meta name="description" content="来小红书，和全世界最有趣的人做朋友">');

  it("a short link is asked for as a phone first, and is counted as Xiaohongshu", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, () => article()) });
    const ann = await signIn(env);
    for (const short of ["https://xhslink.cn/o/AbCd", "http://xhslink.com/a/b"]) {
      asked.length = 0;
      await read(env, ann, short);
      expect(`${short} ${asked[0]?.ua} ${asked.length}`).toBe(`${short} iphone 1`);
    }
    expect(await db(env, "SELECT platform, path, n FROM fetch_stats")).toEqual([{ platform: "xiaohongshu", path: "direct", n: 2 }]);
  });

  it("a short link that the site sends on to its sign-in page is 'not fetched': the sign-in page is not asked for, its words are not stored, and the item keeps its title", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({
      OUTBOUND: asking(asked, (url, ua) => {
        if (url === "https://xhslink.cn/o/AbCd") return new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/discovery/item/6aa2" } });
        if (url === "https://www.xiaohongshu.com/discovery/item/6aa2") return new Response(null, { status: 302, headers: { location: SIGN_IN } });
        return loginPage();
      }),
    });
    const ann = await signIn(env);
    const shared = await read(env, ann, "https://xhslink.cn/o/AbCd", { title: "阳台上的薄荷" });
    expect(shared.item).toMatchObject({ title: "阳台上的薄荷", content_unavailable: true });
    expect(shared.body).toBe("");
    // Nothing shared with it: the host name stands in, never the sign-in page's words.
    const bare = await read(env, ann, "https://xhslink.cn/o/EfGh");
    expect(bare.item).toMatchObject({ content_unavailable: true, title: "xhslink.cn" });
    expect(bare.item.title).not.toContain("登录");
    expect(asked.some((a) => a.url === SIGN_IN)).toBe(false);
    // The phone first, then the desktop; both were sent to the sign-in page, and neither asked for it.
    expect([...new Set(asked.map((a) => a.ua))]).toEqual(["iphone", "desktop"]);
    expect(await db(env, "SELECT platform, path, n FROM fetch_stats")).toEqual([{ platform: "xiaohongshu", path: "none", n: 2 }]);
  });

  it("a sign-in page that is not at a sign-in address is still one, by what it says: it is not content, and its words are not the title", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => loginPage()) });
    const ann = await signIn(env);
    const r = await read(env, ann, "https://www.xiaohongshu.com/explore/6aa2");
    expect(r.item).toMatchObject({ content_unavailable: true, title: "xiaohongshu.com" });
    expect(r.body).toBe("");
    expect(r.item.title).not.toContain("Continue with Google");
  });

  it("the same explanation in a long article is read as an article", async () => {
    const env = makeEnv({ OUTBOUND: asking([], () => page("OAuth in ten minutes", `<p>How to add a Continue with Google button to a site.</p>${`<p>${TEA}</p>`.repeat(6)}`)) });
    const ann = await signIn(env);
    const r = await read(env, ann, "https://blog.example.org/oauth");
    expect(r.item).toMatchObject({ content_unavailable: false, title: "OAuth in ten minutes" });
    expect(r.body).toContain("Continue with Google");
  });

  it("a short link that has run out ends on the front page of the site: the front page is not asked for, its feed is not stored, the item keeps its title", async () => {
    const asked: Ask[] = [];
    const feed = () => page("小红书 - 你的生活指南", ["小红书 App", "你的生活指南", "打开看看", "热门笔记", `${TEA}`, `${TEA}`].map((l) => `<p>${l}</p>`).join(""));
    const env = makeEnv({
      OUTBOUND: asking(asked, (url) => (url.startsWith("https://xhslink.cn/o/dead") ? new Response(null, { status: 302, headers: { location: "https://www.xiaohongshu.com/" } }) : feed())),
    });
    const ann = await signIn(env);
    const r = await read(env, ann, "https://xhslink.cn/o/dead", { title: "阳台上的薄荷" });
    expect(r.item).toMatchObject({ title: "阳台上的薄荷", content_unavailable: true });
    expect(r.body).toBe("");
    expect(asked.some((a) => a.url === "https://www.xiaohongshu.com/")).toBe(false);
    const bare = await read(env, ann, "https://xhslink.cn/o/dead2");
    expect(bare.item).toMatchObject({ content_unavailable: true, title: "xhslink.cn" });
  });

  it("a link to a sign-in address that the user saved is not read either: there is nothing to read behind it", async () => {
    const asked: Ask[] = [];
    const env = makeEnv({ OUTBOUND: asking(asked, () => article()) });
    const ann = await signIn(env);
    const r = await read(env, ann, "https://example.org/login?next=%2Fa", { title: "My account page" });
    expect(r.item).toMatchObject({ content_unavailable: true, title: "My account page" });
    expect(asked).toEqual([]);
  });
});
