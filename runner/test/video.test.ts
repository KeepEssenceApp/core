// #103: reading what is said in a video post, end to end with a real browser: the page part (which pages are a
// video post, what is returned for them) and the interface (202, the job, its auth). Fabricated pages only; the
// media steps are made up (helpers.ts `fakes`), so no yt-dlp, no ffmpeg and no network are needed.
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { MediaRef } from "../src/media.ts";
import { KEY, page, redirect, SAID, start, TEA, WALL, type Options, type Routes, type Started } from "./helpers.ts";

let running: Started | null = null;
afterEach(async () => {
  await running?.close();
  running = null;
});
const run = async (routes: Routes, opts?: Options) => (running = await start(routes, opts));
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return ok();
};
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
const waitDone = async (s: Started, id: string) => {
  assert.ok(await until(() => s.jobs.get(id)?.state === "done"), "the job did not finish");
  return (await s.call("GET", `jobs/${id}`)).json;
};

// ---------------------------------------------------------------- fixtures

const MP4 = "http://sns-video-bd.xhscdn.com/stream/1/110/258/0a1b2c3d4e.mp4";
const CAPTION = "周末把阳台收拾了一遍，种了薄荷和罗勒，晚上泡了一杯薄荷茶。 #阳台[话题]# #薄荷[话题]#";
const CAPTION_SHOWN = "周末把阳台收拾了一遍，种了薄荷和罗勒，晚上泡了一杯薄荷茶。 #阳台# #薄荷#";
/** The fields of a Xiaohongshu video note that the runner reads (the paths are the page's own data's: type, video.capa.duration, video.media.video.duration, video.media.stream.h264[].masterUrl). */
const videoNote = (over: Record<string, unknown> = {}) => ({
  type: "video",
  title: "阳台上的薄荷",
  desc: CAPTION,
  user: { nickName: "某某的阳台" },
  video: { capa: { duration: 111 }, media: { video: { duration: 111 }, stream: { h264: [{ masterUrl: MP4, qualityType: "HD" }] } } },
  ...over,
});
const feed = Array.from({ length: 30 }, (_, i) => `<p>热门推荐里别人的第${i}条笔记标题，和这一条没有关系</p>`).join("");
const note = (n: object) =>
  page("阳台上的薄荷 - rednote", `<div id="app"><p>阳台上的薄荷</p><p>关注</p><p>打开小红书查看全部精彩评论</p>${feed}</div><script>window.__INITIAL_STATE__ = ${JSON.stringify({ noteData: { data: { noteData: n } } })};</script>`);
const XHS = (n: string) => `http://www.xiaohongshu.com/explore/${n}`;

const wechat = (body: string) => page("一篇关于泡茶的文章", `<div id="js_content"><p>${TEA}</p><p>${TEA}</p>${body}</div>`);
const CHROME = ["微信扫一扫关注该公众号", "继续滑动看下一个", "轻触阅读原文", "向上滑动看下一个", "当前内容无法在此显示，请使用微信客户端打开", "点击下方按钮在微信中查看完整文章内容", "小程序", "赞", "在看", "分享", "留言", "收藏"];
const DESCRIPTION = "这条视频讲的是怎么把一壶茶泡好：水温、时间、茶叶的量，还有第二泡要不要换水，都在里面说了。";
const videoPage = (title: string, desc = DESCRIPTION) => page(title, "<p>Home</p><p>Popular</p>", `<meta property="og:description" content="${desc}">`);

// ---------------------------------------------------------------- a Xiaohongshu video note

describe("a Xiaohongshu video note", () => {
  it("is 202: the author's own text as the content, and a job to ask about; the job is read by the page's media address and length", async () => {
    const s = await run({ [XHS("video")]: () => note(videoNote()) });
    const r = await s.read(XHS("video"));
    assert.equal(r.status, 202);
    assert.equal(r.json.code, 202);
    assert.equal(r.json.status, 20200);
    assert.equal(r.json.data.url, XHS("video"));
    assert.equal(r.json.data.title, "阳台上的薄荷");
    assert.equal(r.json.data.content, `阳台上的薄荷\n某某的阳台\n${CAPTION_SHOWN}`);
    for (const noise of ["热门推荐", "打开小红书"]) assert.ok(!r.json.data.content.includes(noise), noise);
    assert.deepEqual(Object.keys(r.json.video), ["state", "job", "seconds"]);
    assert.equal(r.json.video.state, "reading");
    assert.match(r.json.video.job, /^[0-9a-f]{24,}$/);
    assert.equal(r.json.video.seconds, 111);
    // It is read from the address in the page's data, with the note's own site as the referer, and the length is not asked about again.
    assert.ok(await until(() => s.calls.download.length === 1));
    assert.deepEqual(s.calls.download[0], { kind: "direct", urls: [MP4], seconds: 111, referer: "http://www.xiaohongshu.com/" });
    assert.equal(s.calls.probe.length, 0);
    assert.deepEqual(await waitDone(s, r.json.video.job), { state: "done", video_state: "recognized", recognized_text: SAID });
  });

  it("a video note with an empty caption (or only a name) is 202 with no text, and a short caption is returned: neither is 422", async () => {
    const s = await run({
      [XHS("empty")]: () => note(videoNote({ title: "", desc: "" })),
      [XHS("nobody")]: () => note({ type: "video", video: videoNote().video }),
      [XHS("short")]: () => note(videoNote({ title: "薄荷", desc: "#阳台" })),
    });
    for (const n of ["empty", "nobody"]) {
      const r = await s.read(XHS(n));
      assert.equal(`${n} ${r.status}`, `${n} 202`);
      assert.equal(r.json.data.content, "", n);
      assert.equal(r.json.video.state, "reading");
    }
    const short = await s.read(XHS("short"));
    assert.equal(short.status, 202);
    assert.equal(short.json.data.content, "薄荷\n某某的阳台\n#阳台");
  });

  it("a note that is not a video is read as it was: no video field, and a short one is still 422", async () => {
    const image = { type: "normal", title: "阳台上的薄荷", desc: CAPTION, user: { nickName: "某某的阳台" }, video: videoNote().video };
    const s = await run({ [XHS("image")]: () => note(image), [XHS("thin")]: () => note({ type: "normal", title: "薄荷", desc: "#阳台", user: { nickName: "某某" } }) });
    const ok = await s.read(XHS("image"));
    assert.equal(ok.status, 200);
    assert.equal(ok.json.data.content, `阳台上的薄荷\n某某的阳台\n${CAPTION_SHOWN}`);
    assert.ok(!("video" in ok.json));
    const thin = await s.read(XHS("thin"));
    assert.equal(`${thin.status} ${thin.json.error}`, "422 thin");
    assert.equal(s.calls.download.length + s.calls.probe.length, 0);
    assert.deepEqual(s.logs.map((l) => JSON.parse(l).video), [undefined, undefined]);
  });

  it("is not read when it is over 15 minutes (not downloaded), when the queue is full, or when reading is not set up; the note's words are returned each time", async () => {
    const hold = gate();
    let downloads = 0;
    const s = await run(
      {
        [XHS("long")]: () => note(videoNote({ video: { capa: { duration: 16 * 60 }, media: { stream: { h264: [{ masterUrl: MP4 }] } } } })),
        [XHS("limit")]: () => note(videoNote({ video: { capa: { duration: 15 * 60 }, media: { stream: { h264: [{ masterUrl: MP4 }] } } } })),
        [XHS("a")]: () => note(videoNote()),
        [XHS("b")]: () => note(videoNote()),
        [XHS("c")]: () => note(videoNote()),
      },
      {
        env: { RUNNER_VIDEO_QUEUE: "1" },
        jobs: {
          download: async (_ref: MediaRef, dir: string) => {
            downloads++;
            await hold.opened;
            await writeFile(join(dir, "media.mp4"), "video");
            return join(dir, "media.mp4");
          },
        },
      },
    );
    const long = await s.read(XHS("long"));
    assert.equal(long.status, 200);
    assert.equal(long.json.status, 20000);
    assert.deepEqual(long.json.video, { state: "too_long", seconds: 960 });
    assert.equal(long.json.data.content, `阳台上的薄荷\n某某的阳台\n${CAPTION_SHOWN}`);
    assert.equal(downloads, 0, "a video that is too long is not downloaded");
    assert.equal((await s.read(XHS("limit"))).status, 202, "15 minutes is read");
    assert.equal((await s.read(XHS("a"))).status, 202, "one waiting");
    const full = await s.read(XHS("b"));
    assert.equal(full.status, 200);
    assert.deepEqual(full.json.video, { state: "unavailable", seconds: 111 });
    assert.equal(full.json.data.content, `阳台上的薄荷\n某某的阳台\n${CAPTION_SHOWN}`);
    assert.equal(downloads, 1, "one runs at a time");
    hold.open();

    await s.close();
    const off = await run({ [XHS("c")]: () => note(videoNote()) }, { jobs: { enabled: false } });
    const unset = await off.read(XHS("c"));
    assert.equal(unset.status, 200);
    assert.deepEqual(unset.json.video, { state: "unavailable", seconds: 111 });
    assert.ok(unset.json.data.content.includes("薄荷"));
  });

  it("a note whose video has no media address is unavailable (the words still come back)", async () => {
    const s = await run({ [XHS("nourl")]: () => note(videoNote({ video: { capa: { duration: 60 } } })), [XHS("nolength")]: () => note(videoNote({ video: { media: { stream: { h264: [{ masterUrl: MP4 }] } } } })) });
    const a = await s.read(XHS("nourl"));
    assert.equal(a.status, 200);
    assert.deepEqual(a.json.video, { state: "unavailable", seconds: 60 });
    const b = await s.read(XHS("nolength"));
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.video, { state: "unavailable", seconds: null });
    assert.ok(b.json.data.content.includes("薄荷"));
  });

  it("a media address that is not public is never given to the download", async () => {
    const bad = { capa: { duration: 60 }, media: { stream: { h264: [{ masterUrl: "http://192.168.0.7/a.mp4" }, { masterUrl: "http://localhost/a.mp4" }, { masterUrl: "file:///etc/passwd" }, { masterUrl: MP4 }] } } };
    const s = await run({ [XHS("bad")]: () => note(videoNote({ video: bad })) });
    assert.equal((await s.read(XHS("bad"))).status, 202);
    assert.ok(await until(() => s.calls.download.length === 1));
    assert.deepEqual((s.calls.download[0] as { urls: string[] }).urls, [MP4]);
  });
});

// ---------------------------------------------------------------- the other platforms

describe("the other platforms", () => {
  it("a WeChat article with a Tencent video in it is read for both, whether its text is long or not (and the iframe's src or its lazy data-src)", async () => {
    const s = await run({
      "http://mp.weixin.qq.com/s?__biz=lazy": () => wechat('<iframe class="video_iframe" data-src="https://v.qq.com/iframe/preview.html?vid=wxv_1234567890123&amp;width=500&amp;height=375"></iframe>'),
      "http://mp.weixin.qq.com/s?__biz=src": () => wechat('<iframe src="http://v.qq.com/iframe/player.html?vid=x3456abcde"></iframe>'),
      "http://mp.weixin.qq.com/s?__biz=shell": () => page("一篇关于松木家具保养的文章", CHROME.map((l) => `<p>${l}</p>`).join("") + '<iframe data-src="https://v.qq.com/iframe/preview.html?vid=x0000shell1"></iframe>'),
      "http://mp.weixin.qq.com/s?__biz=none": () => wechat(""),
    });
    const lazy = await s.read("http://mp.weixin.qq.com/s?__biz=lazy");
    assert.equal(lazy.status, 202);
    assert.ok(lazy.json.data.content.includes("Steep green tea"), "the article's own text");
    assert.equal(lazy.json.video.state, "reading");
    assert.equal(lazy.json.video.seconds, 120);
    const src = await s.read("http://mp.weixin.qq.com/s?__biz=src");
    assert.equal(src.status, 202);
    assert.deepEqual(s.calls.probe, ["https://v.qq.com/x/page/wxv_1234567890123.html", "https://v.qq.com/x/page/x3456abcde.html"]);
    assert.ok(await until(() => s.calls.download.length === 2));
    assert.deepEqual(s.calls.download.map((r) => (r as { page: string }).page), s.calls.probe);
    // The page's buttons are not the author's text: with a video the content is empty, and it is not 422.
    const shell = await s.read("http://mp.weixin.qq.com/s?__biz=shell");
    assert.equal(shell.status, 202);
    assert.equal(shell.json.data.content, "");
    // An article with no video is read as it always was (and a shell without one is still 422: see the rules' own tests).
    const none = await s.read("http://mp.weixin.qq.com/s?__biz=none");
    assert.equal(none.status, 200);
    assert.ok(!("video" in none.json));
  });

  it("a Tencent iframe that is not a WeChat article's, an iframe from another site, or an id that is not an id, is not a video", async () => {
    const s = await run({
      "http://blog.example.org/embed": () => page("A post with a video", `<article><p>${TEA}</p><p>${TEA}</p><iframe src="http://v.qq.com/iframe/player.html?vid=x3456abcde"></iframe></article>`),
      "http://mp.weixin.qq.com/s?__biz=other": () => wechat('<iframe data-src="https://www.youtube.com/embed/abcdefghijk?vid=x3456abcde"></iframe><iframe data-src="https://v.qq.com/iframe/preview.html?vid=../../etc/passwd"></iframe><iframe data-src="https://v.qq.com/iframe/preview.html"></iframe>'),
    });
    for (const url of ["http://blog.example.org/embed", "http://mp.weixin.qq.com/s?__biz=other"]) {
      const r = await s.read(url);
      assert.equal(r.status, 200, url);
      assert.ok(!("video" in r.json), url);
    }
    assert.equal(s.calls.probe.length, 0);
  });

  it("Bilibili, a Weibo video and Tencent Video are asked for their length through the media page; a short link is followed first", async () => {
    const s = await run({
      "http://www.bilibili.com/video/BV1xx411c7mD": () => videoPage("怎么泡茶_哔哩哔哩_bilibili"),
      "http://b23.tv/abcDEF": () => redirect("http://www.bilibili.com/video/BV1yy411c7mE"),
      "http://www.bilibili.com/video/BV1yy411c7mE": () => videoPage("另一个视频_哔哩哔哩_bilibili"),
      "http://video.weibo.com/show?fid=1034:4567890123456789": () => videoPage("一条微博视频"),
      "http://v.qq.com/x/page/x3456abcde.html": () => videoPage("腾讯视频上的一条"),
      "http://www.bilibili.com/space/12345": () => videoPage("某个用户的空间"),
      "http://weibo.com/1234567890/Nabc123": () => videoPage("一条普通的微博"),
    });
    const urls = ["http://www.bilibili.com/video/BV1xx411c7mD", "http://b23.tv/abcDEF", "http://video.weibo.com/show?fid=1034:4567890123456789", "http://v.qq.com/x/page/x3456abcde.html"];
    for (const url of urls) {
      const r = await s.read(url);
      assert.equal(`${url} ${r.status}`, `${url} 202`);
      // The page's own words as the core's rules take them: a short-post site's description is the post, Tencent Video's is not on that list.
      assert.equal(r.json.data.content, url.includes("v.qq.com") ? "" : DESCRIPTION, url);
      assert.equal(r.json.video.seconds, 120);
    }
    assert.deepEqual(s.calls.probe, ["http://www.bilibili.com/video/BV1xx411c7mD", "http://www.bilibili.com/video/BV1yy411c7mE", "http://video.weibo.com/show?fid=1034:4567890123456789", "http://v.qq.com/x/page/x3456abcde.html"]);
    // Pages of these sites that are not a video's page are read as pages.
    for (const url of ["http://www.bilibili.com/space/12345", "http://weibo.com/1234567890/Nabc123"]) {
      const r = await s.read(url);
      assert.equal(`${url} ${r.status}`, `${url} 200`);
      assert.ok(!("video" in r.json), url);
    }
    assert.equal(s.calls.probe.length, 4);
  });

  it("a video page with no words (a shell, a wall) is still a video: 202 with an empty text, not 422", async () => {
    const s = await run({
      "http://www.bilibili.com/video/BV1thin": () => page("哔哩哔哩", "<p>Home</p>"),
      "http://www.bilibili.com/video/BV1wall": () => WALL(),
    });
    for (const n of ["BV1thin", "BV1wall"]) {
      const r = await s.read(`http://www.bilibili.com/video/${n}`);
      assert.equal(`${n} ${r.status}`, `${n} 202`);
      assert.equal(r.json.data.content, "", n);
      assert.ok(!JSON.stringify(r.json).includes("环境异常"), "what the wall said is not returned");
    }
  });

  it("the length of a long video is asked for before anything is downloaded: too_long is answered from the media page", async () => {
    const s = await run({ "http://www.bilibili.com/video/BV1long": () => videoPage("一个很长的视频") }, { jobs: { probe: async () => 3600 } });
    const r = await s.read("http://www.bilibili.com/video/BV1long");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.video, { state: "too_long", seconds: 3600 });
    assert.equal(r.json.data.content, DESCRIPTION);
    assert.equal(s.calls.download.length, 0);
  });

  it("a length that is not told in time, or not at all, is unavailable: the page's words are returned and the read is not late", async () => {
    const s = await run(
      { "http://www.bilibili.com/video/BV1slow": () => videoPage("一个视频"), "http://www.bilibili.com/video/BV1none": () => videoPage("另一个视频") },
      { env: { RUNNER_DEADLINE_MS: "2500" }, jobs: { probe: (p: string, signal: AbortSignal) => (p.endsWith("BV1slow") ? untilAborted(signal) : Promise.resolve(null)) } },
    );
    const started = Date.now();
    const slow = await s.read("http://www.bilibili.com/video/BV1slow");
    assert.ok(Date.now() - started < 5000);
    assert.equal(slow.status, 200);
    assert.deepEqual(slow.json.video, { state: "unavailable", seconds: null });
    assert.equal(slow.json.data.content, DESCRIPTION);
    const none = await s.read("http://www.bilibili.com/video/BV1none");
    assert.deepEqual(none.json.video, { state: "unavailable", seconds: null });
  });

  // (A page on www.douyin.com itself never reached the made-up network in the browser here (no request was made; not looked into, perhaps an https-only rule of Chromium's); the Douyin page below is on iesdouyin.com, the host of its share pages, and the address rules for douyin.com are in media.test.ts.)
  it("WeChat Channels and Douyin are video posts that are not read: unavailable at once, and no text is not a failure", async () => {
    const shell = () => page("", "<script>var x = 1;</script>");
    const s = await run({
      "http://weixin.qq.com/sph/Aabc123": shell,
      "http://channels.weixin.qq.com/web/pages/feed": shell,
      "http://www.iesdouyin.com/share/video/7123456789": () => page("抖音", "<p>登录</p>"),
      "http://www.iesdouyin.com/share/video/7000000000": () => videoPage("一个有说明的抖音视频"),
    });
    for (const url of ["http://weixin.qq.com/sph/Aabc123", "http://channels.weixin.qq.com/web/pages/feed", "http://www.iesdouyin.com/share/video/7123456789"]) {
      const r = await s.read(url);
      assert.equal(`${url} ${r.status}`, `${url} 200`);
      assert.equal(r.json.data.content, "", url);
      assert.deepEqual(r.json.video, { state: "unavailable", seconds: null }, url);
    }
    // When the page does have words, they are returned.
    const words = await s.read("http://www.iesdouyin.com/share/video/7000000000");
    assert.equal(words.status, 200);
    assert.equal(words.json.data.content, DESCRIPTION);
    assert.deepEqual(words.json.video, { state: "unavailable", seconds: null });
    assert.equal(s.calls.probe.length + s.calls.download.length, 0);
    assert.deepEqual(s.jobs.retained(), []);
  });

  it("a page that cannot be opened at all is as it was (502), even when its address is a video's", async () => {
    const s = await run({ "http://www.bilibili.com/video/BV1gone": () => ({ status: 404, headers: { "content-type": "text/html" }, body: "gone" }) });
    const r = await s.read("http://www.bilibili.com/video/BV1gone");
    assert.equal(r.status, 502);
    assert.equal(s.calls.probe.length, 0);
  });

  it("a plain page is as it was: no video field", async () => {
    const s = await run({ "http://blog.example.org/tea": () => page("How to brew tea", `<article><h1>How to brew tea</h1><p>${TEA}</p><p>${TEA}</p></article>`) });
    const r = await s.read("http://blog.example.org/tea");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ["code", "data", "status"]);
    assert.deepEqual(Object.keys(r.json.data).sort(), ["content", "title", "url"]);
  });
});

// ---------------------------------------------------------------- the jobs' interface

describe("GET and DELETE /jobs/<id>", () => {
  it("want the key; an id that is not known is 404 {error: unknown} and deleting it is 204; other methods are 405", async () => {
    const s = await run({ [XHS("video")]: () => note(videoNote()) });
    const r = await s.read(XHS("video"));
    const id = r.json.video.job;
    for (const key of [null, "", "wrong", KEY.slice(0, -1), KEY + "x"]) {
      for (const method of ["GET", "DELETE"]) assert.equal((await s.call(method, `jobs/${id}`, key)).status, 401, `${method} ${key}`);
    }
    assert.ok(["reading", "done"].includes((await s.call("GET", `jobs/${id}`)).json.state));
    const unknown = await s.call("GET", `jobs/${"0".repeat(32)}`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(unknown.json, { error: "unknown" });
    for (const odd of ["jobs/", "jobs/x", "jobs/..%2F..%2Fetc", "jobs/" + "A".repeat(32), `jobs/${id}/x`]) assert.equal((await s.call("GET", odd)).status, 404, odd);
    assert.equal((await s.call("DELETE", `jobs/${"0".repeat(32)}`)).status, 204);
    assert.equal((await s.call("DELETE", "jobs/x")).status, 204);
    assert.equal((await s.call("POST", `jobs/${id}`)).status, 405);
    assert.equal((await s.call("PUT", `jobs/${id}`)).status, 405);
    // Still there after all that.
    assert.equal((await s.call("GET", `jobs/${id}`)).status, 200);
  });

  it("is done with the words, or without them: recognized, no_speech, too_long, unavailable", async () => {
    const outcomes: [string, () => Promise<unknown>, Record<string, unknown>][] = [
      ["recognized", async () => ({ kind: "text", text: SAID }), { state: "done", video_state: "recognized", recognized_text: SAID }],
      ["no_speech", async () => ({ kind: "no_speech" }), { state: "done", video_state: "no_speech" }],
      ["too_long", async () => ({ kind: "too_long" }), { state: "done", video_state: "too_long" }],
      ["unavailable", () => Promise.reject(new Error("the worker is down")), { state: "done", video_state: "unavailable" }],
    ];
    for (const [name, transcribe, expected] of outcomes) {
      const s = await run({ [XHS("video")]: () => note(videoNote()) }, { jobs: { transcribe: transcribe as never } });
      const r = await s.read(XHS("video"));
      assert.deepEqual(await waitDone(s, r.json.video.job), expected, name);
      await s.close();
      running = null;
    }
  });

  it("DELETE stops a running job: the download is told, the files are gone, the job is forgotten", async () => {
    let dir = "";
    let aborted = false;
    const s = await run({ [XHS("video")]: () => note(videoNote()) }, {
      jobs: {
        download: async (_ref: MediaRef, d: string, signal: AbortSignal) => {
          dir = d;
          await writeFile(join(d, "media.mp4.part"), "half");
          return untilAborted(signal).catch((e) => {
            aborted = true;
            throw e;
          });
        },
      },
    });
    const r = await s.read(XHS("video"));
    assert.ok(await until(() => dir !== ""));
    assert.ok(existsSync(dir));
    assert.equal((await s.call("DELETE", `jobs/${r.json.video.job}`)).status, 204);
    assert.ok(aborted);
    assert.equal(existsSync(dir), false);
    assert.equal((await s.call("GET", `jobs/${r.json.video.job}`)).status, 404);
    assert.deepEqual(readdirSync(s.jobsRoot), []);
  });

  it("a caller that went away before the answer leaves no job behind", async () => {
    let asked = false;
    const s = await run({ "http://www.bilibili.com/video/BV1gone": () => videoPage("一个视频") }, {
      jobs: {
        probe: async () => {
          asked = true;
          await new Promise((r) => setTimeout(r, 700));
          return 100;
        },
      },
    });
    const ctl = new AbortController();
    const pending = fetch(`${s.base}/http://www.bilibili.com/video/BV1gone`, { headers: { authorization: `Bearer ${KEY}` }, signal: ctl.signal }).catch(() => null);
    assert.ok(await until(() => asked));
    ctl.abort();
    await pending;
    assert.ok(await until(() => s.logs.some((l) => JSON.parse(l).video === "reading")), "the read finished");
    assert.ok(await until(() => s.jobs.retained().length === 0), "a job nobody can ask about was kept");
    assert.ok(await until(() => readdirSync(s.jobsRoot).length === 0));
  });

  it("DELETE forgets a result that is done", async () => {
    const s = await run({ [XHS("video")]: () => note(videoNote()) });
    const r = await s.read(XHS("video"));
    await waitDone(s, r.json.video.job);
    assert.equal((await s.call("DELETE", `jobs/${r.json.video.job}`)).status, 204);
    assert.equal((await s.call("GET", `jobs/${r.json.video.job}`)).status, 404);
  });
});

describe("what is logged for a video", () => {
  it("how each read and each job went, for how long, and for which platform class: never an address, a name, a job, a caption or what was said", async () => {
    const s = await run({
      [XHS("secretnote")]: () => note(videoNote({ title: "私人的标题", user: { nickName: "秘密的昵称" } })),
      "http://www.bilibili.com/video/BV1secret99": () => videoPage("一个私人视频"),
      "http://weixin.qq.com/sph/Asecret456": () => page("", "<script>var x = 1;</script>"),
    });
    const a = await s.read(XHS("secretnote"));
    const b = await s.read("http://www.bilibili.com/video/BV1secret99");
    await s.read("http://weixin.qq.com/sph/Asecret456");
    await waitDone(s, a.json.video.job);
    await waitDone(s, b.json.video.job);
    await s.call("DELETE", `jobs/${a.json.video.job}`);
    const text = s.logs.join("\n");
    for (const never of ["secretnote", "BV1secret99", "Asecret456", "xhscdn", "bilibili.com", "weixin", "私人", "秘密", "薄荷", "泡", SAID, a.json.video.job, b.json.video.job, KEY, "http", "yt-dlp", "ffmpeg"]) assert.ok(!text.includes(never), never);
    const lines = s.logs.map((l) => JSON.parse(l));
    for (const line of lines) assert.deepEqual(Object.keys(line).filter((k) => !["at", "result", "video", "video_state", "stage", "platform", "ms"].includes(k)), [], JSON.stringify(line));
    const reads = lines.filter((l) => l.video).map((l) => [l.platform, l.result, l.video]);
    assert.deepEqual(reads, [["xiaohongshu", "ok", "reading"], ["bilibili", "ok", "reading"], ["wechat", "ok", "unavailable"]]);
    assert.deepEqual(lines.filter((l) => l.result === "video_done").map((l) => [l.platform, l.video_state]).sort(), [["bilibili", "recognized"], ["xiaohongshu", "recognized"]]);
  });
});
