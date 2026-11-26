// QA #100: the rules the direct read judges a page by. Fabricated text only.
import { describe, expect, it } from "vitest";
import { assessPage, CAPTION_CHARS, onDomain, THIN_CHARS, titleWins, usableTitle, userAgentsFor, UA_DESKTOP, UA_IPHONE, WALL_HINTS, wallHint } from "../src/services/pagerules";

const lines = (...l: string[]) => l.join("\n");
const ARTICLE = "Steep green tea for two minutes in water of about eighty degrees, and taste it before the second cup, because the leaves give more each time they are steeped.";

describe("QA #100: which User-Agent, in what order", () => {
  it("desktop first and the iPhone second; the phone first for the apps that want it", () => {
    expect(userAgentsFor("https://blog.example.org/tea")).toEqual([UA_DESKTOP, UA_IPHONE]);
    for (const phone of [
      "https://www.xiaohongshu.com/explore/1", "http://xhslink.com/a/b", "https://www.rednote.com/x", "https://www.douyin.com/video/1", "https://v.douyin.com/x", "https://www.bilibili.com/video/BV1",
      "https://b23.tv/abc", "https://weibo.com/1/2", "https://m.weibo.cn/status/3", "https://t.cn/AbC", "https://www.kuaishou.com/x", "https://www.zhihu.com/question/1", "https://zhuanlan.zhihu.com/p/1",
    ]) {
      expect(`${phone} ${userAgentsFor(phone)[0] === UA_IPHONE}`).toBe(`${phone} true`);
      expect(userAgentsFor(phone)).toEqual([UA_IPHONE, UA_DESKTOP]);
    }
    expect(UA_DESKTOP).toContain("Windows NT");
    expect(UA_IPHONE).toContain("iPhone");
  });

  it("a host is matched on a domain boundary: look-alikes and addresses that only mention an app do not count", () => {
    for (const desktop of [
      "https://notxiaohongshu.com/a", "https://xiaohongshu.com.example.org/a", "https://example.org/xiaohongshu.com", "https://example.org/post?from=zhihu.com", "https://example.org/#weibo.cn",
      "https://bilibili.com.cn.example.net/", "https://fakezhihu.com/", "https://mp.weixin.qq.com/s?__biz=abc", "not an address",
    ]) {
      expect(`${desktop} ${userAgentsFor(desktop)[0] === UA_DESKTOP}`).toBe(`${desktop} true`);
    }
    expect(onDomain("a.b.example.org", ["example.org"])).toBe(true);
    expect(onDomain("example.org", ["example.org"])).toBe(true);
    expect(onDomain("badexample.org", ["example.org"])).toBe(false);
  });
});

describe("QA #100: a verification wall", () => {
  it("each wall word at the top of a page, in its title, its description or its first lines, is found", () => {
    for (const hint of WALL_HINTS) {
      expect(wallHint({ text: `${hint}\nsomething else` })).toBe(hint);
      expect(wallHint({ title: `Page ${hint}` })).toBe(hint);
      expect(wallHint({ description: hint })).toBe(hint);
      expect(wallHint({ noscript: hint })).toBe(hint);
    }
    expect(wallHint({ text: ARTICLE, title: "How to brew tea", description: "Tea." })).toBeNull();
    expect(wallHint({})).toBeNull();
  });

  it("a wall of more than 60 characters is a wall, however long its explanation", () => {
    const text = lines("环境异常", "当前环境异常，完成验证后即可继续访问，请点击下面的按钮，按照页面的提示完成安全验证，验证通过之后页面会自动刷新并回到你要看的内容。", "去验证");
    expect(text.replace(/\s+/g, "").length).toBeGreaterThan(THIN_CHARS);
    expect(wallHint({ text })).not.toBeNull();
    expect(assessPage({ url: "https://mp.weixin.qq.com/s?x=1", text, wall: wallHint({ text }) })).toMatchObject({ quality: "blocked" });
  });

  it("the markup counts only for a short page: a long article that mentions the words later on is still an article", () => {
    const head = "<noscript>Enable JavaScript and cookies to continue</noscript>";
    expect(wallHint({ text: "", head })).toBe("Enable JavaScript and cookies");
    expect(wallHint({ text: "Please wait.", head })).toBe("Enable JavaScript and cookies");
    const article = lines(ARTICLE, ARTICLE, ARTICLE, ARTICLE);
    expect(wallHint({ text: article, head })).toBeNull();
    // The words far down a long article's text are not at its top.
    const deep = lines(ARTICLE, ARTICLE, ARTICLE, ARTICLE, "第四步：如果网站提示完成验证，按提示做就行。");
    expect(wallHint({ text: deep })).toBeNull();
  });
});

describe("QA #100: content, or only the shell around it", () => {
  const url = "https://blog.example.org/tea";

  it("ordinary text is content; the 60-character floor stays", () => {
    expect(assessPage({ url, text: ARTICLE })).toMatchObject({ quality: "ok" });
    expect(assessPage({ url: "https://example.com/", text: lines("Example Domain", "This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.") })).toMatchObject({ quality: "ok" });
    expect(assessPage({ url, text: "Only a few words of text here." })).toMatchObject({ quality: "thin", reason: "too little text" });
    expect(assessPage({ url, text: "" })).toMatchObject({ quality: "thin" });
    expect(assessPage({ url, text: "x".repeat(THIN_CHARS - 1) }).quality).toBe("thin");
    expect(assessPage({ url, text: "x".repeat(THIN_CHARS) }).quality).toBe("ok");
  });

  it("a WeChat article with only the page's own words is a shell, whatever its length under 200 characters", () => {
    const chrome = lines("微信扫一扫关注该公众号", "继续滑动看下一个", "轻触阅读原文", "向上滑动看下一个", "当前内容无法在此显示，请使用微信客户端打开", "点击下方按钮在微信中查看完整文章内容", "小程序", "赞", "在看", "分享", "留言", "收藏");
    const flat = chrome.replace(/\s+/g, "").length;
    expect(flat).toBeGreaterThan(THIN_CHARS);
    expect(flat).toBeLessThan(200);
    expect(assessPage({ url: "https://mp.weixin.qq.com/s?__biz=abc", text: chrome })).toMatchObject({ quality: "thin" });
    // The same words on another site are judged by the general rules.
    expect(assessPage({ url, text: chrome }).quality).toBe("ok");
    // A real body is not.
    const body = Array.from({ length: 6 }, () => "这是文章正文里的一整段话，讲的是怎样把一份活交给一个人，并且让他在约定的时间内做完。").join("\n");
    expect(assessPage({ url: "https://mp.weixin.qq.com/s?__biz=abc", text: body })).toMatchObject({ quality: "ok" });
  });

  it("a column of buttons and short menu lines is a shell even when it is longer than 60 characters", () => {
    const buttons = lines(...["Like", "Share", "Save", "Reply", "Menu", "Home", "Top", "More", "Next", "Prev", "Help", "Login", "Print", "Copy", "Edit", "Back", "Send", "Open"]);
    expect(buttons.replace(/\s+/g, "").length).toBeGreaterThanOrEqual(THIN_CHARS);
    expect(assessPage({ url, text: buttons })).toMatchObject({ quality: "thin", reason: "only page buttons and menus came back" });
  });

  it("a short post: its description is the content on the sites of short posts, from 40 characters; nowhere else, and not by the host's look alone", () => {
    const caption = "周末在家把阳台收拾了一遍，种了薄荷、罗勒和小番茄，晚上泡了一杯薄荷茶，邻居也来坐了一会儿。";
    expect([...caption].length).toBeGreaterThanOrEqual(CAPTION_CHARS);
    expect([...caption].length).toBeLessThan(THIN_CHARS);
    const chrome = lines("Explore", "Post", "Notifications");
    for (const u of ["https://www.xiaohongshu.com/explore/1", "https://x.com/someone/status/1", "https://weibo.com/1/2", "https://www.douyin.com/video/1", "https://www.instagram.com/p/x/"]) {
      expect(assessPage({ url: u, text: chrome, description: caption })).toMatchObject({ quality: "ok", caption: true });
    }
    // Under 40 characters of description is not enough; the page's own menu words never are.
    expect(assessPage({ url: "https://www.xiaohongshu.com/explore/1", text: chrome, description: "太短的描述。" }).quality).toBe("thin");
    expect(assessPage({ url: "https://www.xiaohongshu.com/explore/1", text: chrome }).quality).toBe("thin");
    // Another site, a look-alike host: the floor holds (A13).
    expect(assessPage({ url, text: chrome, description: caption }).quality).toBe("thin");
    expect(assessPage({ url: "https://notxiaohongshu.com/explore/1", text: chrome, description: caption }).quality).toBe("thin");
  });

  it("a Channels share page whose shell holds only scripts is a shell", () => {
    expect(assessPage({ url: "https://weixin.qq.com/sph/AbCdEf", text: "" })).toMatchObject({ quality: "thin" });
  });
});

describe("QA #100: titles", () => {
  const ctx = { url: "https://www.example.org/post/1", site: "The Example Blog" };

  it("an address, a wall, a login, error or verification page, or only the site's name is not a title", () => {
    for (const bad of [
      "", " ", "x", "https://example.org/post/1", "http://example.org", "www.example.org", "example.org/post/1", "example.org", "www.example.org",
      "Just a moment...", "环境异常", "Weixin Official Accounts Platform", "登录 - 知乎", "登录", "Log in | Example", "Sign in", "404 Not Found", "404", "403 Forbidden", "Access denied",
      "Error", "Error: something went wrong", "Page not found", "Untitled", "Loading...", "Attention Required! | Cloudflare", "Verification", "请稍候…", "安全验证", "The Example Blog", "  the   example BLOG ",
    ]) {
      expect(`${JSON.stringify(bad)} ${usableTitle(bad, ctx)}`).toBe(`${JSON.stringify(bad)} false`);
    }
  });

  it("a title that merely starts like one of those is a title", () => {
    for (const good of ["Error handling in Rust", "Verify your backups", "我的登录页设计", "注册表的备份", "500 Days of Summer", "Node.js", "Loading data in chunks", "How to brew tea", "End", "一个家最好的状态 - rednote"]) {
      expect(`${good} ${usableTitle(good, ctx)}`).toBe(`${good} true`);
    }
    // Without a page address or site there is no name to compare with.
    expect(usableTitle("example.org")).toBe(true);
  });

  it("a title much shorter than the one the item has, and contained in it, does not replace it", () => {
    expect(titleWins("Notes on leases and claims in task queues", "Notes")).toBe(false);
    expect(titleWins("Notes on leases and claims in task queues", "notes on leases and claims in task queues")).toBe(true);
    expect(titleWins("Notes on leases and claims", "Notes on leases")).toBe(true); // more than half
    expect(titleWins("Notes on leases and claims in task queues", "Leases, claims and task queues")).toBe(true); // not contained
    expect(titleWins("example.org", "Example Domain")).toBe(true);
    expect(titleWins("", "Anything")).toBe(true);
    expect(titleWins("Anything", "")).toBe(false);
  });
});
