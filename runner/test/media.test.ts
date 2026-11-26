// #103: the parts around the media steps, without a browser: which addresses are video posts, the argument lists of
// yt-dlp and ffmpeg (they hold the proxy's password and must never be printed), running a program, the call to the
// transcription worker (against a worker made up here), the settings. One optional smoke test runs the real yt-dlp and
// ffmpeg through the real proxy over a made-up network, and is skipped where they are not installed.
import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { tencentPage, tencentVidOf, videoByAddress, videoInFrames, videoOfNote } from "../src/detect.ts";
import { childEnv, run } from "../src/exec.ts";
import { createPipeline, ffmpegArgs, ytdlpDownloadArgs, ytdlpProbeArgs } from "../src/media.ts";
import { platformOf } from "../src/read.ts";
import { transcribeFile } from "../src/transcribe.ts";
import { KEY, start } from "./helpers.ts";

// Built from pieces, so that no secret-looking string is in the source.
const PASSWORD = ["pw", "0123456789", "abcdef"].join("");
const PROXY = `http://user1:${PASSWORD}@127.0.0.1:41234`;
const WORKER_KEY = ["worker", "key", "9876543210"].join("-");

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "media-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const idle = new AbortController().signal;

describe("which addresses are a video post", () => {
  it("by the address alone: the platforms that are read, the ones that cannot be, and the pages that are not a video's", () => {
    const page = (raw: string) => ({ kind: "page", page: raw });
    const table: [string, unknown][] = [
      ["https://www.bilibili.com/video/BV1xx411c7mD", page("https://www.bilibili.com/video/BV1xx411c7mD")],
      // A phone is sent to the mobile site with tracking in the address: the video's own page is what yt-dlp is asked for.
      ["https://m.bilibili.com/video/BV1xx411c7mD?p=2", page("https://www.bilibili.com/video/BV1xx411c7mD?p=2")],
      ["https://m.bilibili.com/video/BV1xx411c7mD?site=OVERSEAS&lang=zh-Hans", page("https://www.bilibili.com/video/BV1xx411c7mD")],
      ["https://bilibili.com/video/BV1xx411c7mD/?spm_id_from=333.1007&vd_source=abc&p=x", page("https://www.bilibili.com/video/BV1xx411c7mD")],
      ["https://www.bilibili.com/video/BV1xx411c7mD?p=3&share_source=copy_web", page("https://www.bilibili.com/video/BV1xx411c7mD?p=3")],
      ["https://www.bilibili.com/video/av170001", page("https://www.bilibili.com/video/av170001")],
      ["https://b23.tv/abcDEF", page("https://b23.tv/abcDEF")],
      ["https://video.weibo.com/show?fid=1034:4567", page("https://video.weibo.com/show?fid=1034:4567")],
      ["https://weibo.com/tv/show/1034:4567", page("https://weibo.com/tv/show/1034:4567")],
      ["https://v.qq.com/x/page/x3456abcde.html", page("https://v.qq.com/x/page/x3456abcde.html")],
      ["https://v.qq.com/x/cover/mzc00200abc/x3456abcde.html", page("https://v.qq.com/x/cover/mzc00200abc/x3456abcde.html")],
      ["https://v.qq.com/iframe/player.html?vid=x3456abcde&tiny=0", page("https://v.qq.com/x/page/x3456abcde.html")],
      ["https://channels.weixin.qq.com/web/pages/feed", { kind: "unsupported" }],
      ["https://weixin.qq.com/sph/Aabc123", { kind: "unsupported" }],
      ["https://www.douyin.com/video/7123456789", { kind: "unsupported" }],
      ["https://v.douyin.com/abcDEF/", { kind: "unsupported" }],
      ["https://www.iesdouyin.com/share/video/7123456789", { kind: "unsupported" }],
      // Not video posts (or not known to be from the address).
      ["https://www.bilibili.com/space/12345", null],
      ["https://www.bilibili.com/read/cv123", null],
      ["https://weibo.com/1234567890/Nabc123", null],
      ["https://mp.weixin.qq.com/s?__biz=abc", null],
      ["https://weixin.qq.com/about", null],
      ["https://www.xiaohongshu.com/explore/abc", null],
      ["https://blog.example.org/video/BV1xx411c7mD", null],
      ["https://notbilibili.com/video/BV1xx411c7mD", null],
      ["https://example.org/?u=https://www.bilibili.com/video/BV1xx411c7mD", null],
      ["https://v.qq.com.example.org/x/page/x3456abcde.html", null],
      ["not an address", null],
    ];
    for (const [url, want] of table) assert.deepEqual(videoByAddress(url), want, url);
  });

  it("a Tencent video's id is a plain id from a v.qq.com address, and nothing else; an embedded one is the first of the page's iframes", () => {
    assert.equal(tencentVidOf("https://v.qq.com/iframe/preview.html?vid=wxv_1234567890123&width=500"), "wxv_1234567890123");
    assert.equal(tencentVidOf("//v.qq.com/iframe/player.html?vid=x3456abcde"), "x3456abcde");
    for (const bad of ["https://v.qq.com/iframe/preview.html", "https://v.qq.com/iframe/preview.html?vid=", "https://v.qq.com/iframe/preview.html?vid=a/b", "https://v.qq.com/iframe/preview.html?vid=..%2F..", "https://example.org/iframe?vid=x3456abcde", "https://v.qq.com.example.org/iframe?vid=x3456abcde", "javascript:alert(1)", "about:blank", "ftp://v.qq.com/a?vid=x3456abcde"]) assert.equal(tencentVidOf(bad), null, bad);
    assert.equal(tencentPage("x3456abcde"), "https://v.qq.com/x/page/x3456abcde.html");
    assert.deepEqual(videoInFrames(["about:blank", "https://www.youtube.com/embed/abc", "https://v.qq.com/iframe/preview.html?vid=x1111aaaaa", "https://v.qq.com/iframe/preview.html?vid=x2222bbbbb"]), { kind: "page", page: "https://v.qq.com/x/page/x1111aaaaa.html" });
    assert.equal(videoInFrames([]), null);
  });

  it("a note's video: only public media addresses, the length rounded up, the note's own site as the referer", () => {
    const urls = ["http://cdn.example.org/a.mp4", "http://cdn.example.org/a.mp4", "http://10.0.0.7/b.mp4", "file:///etc/passwd", "https://cdn2.example.org/c.mp4"];
    assert.deepEqual(videoOfNote({ seconds: 110.2, urls }, "https://www.xiaohongshu.com/explore/abc?x=1"), { kind: "direct", urls: ["http://cdn.example.org/a.mp4", "https://cdn2.example.org/c.mp4"], seconds: 111, referer: "https://www.xiaohongshu.com/" });
    assert.equal((videoOfNote({ seconds: null, urls }, "https://www.rednote.com/x") as { seconds: unknown }).seconds, null);
    assert.equal((videoOfNote({ seconds: 0, urls }, "https://www.rednote.com/x") as { seconds: unknown }).seconds, null);
    assert.equal((videoOfNote({ seconds: 5, urls }, "https://www.rednote.com/x") as { referer: string }).referer, "https://www.rednote.com/");
    assert.equal((videoOfNote({ seconds: 5, urls: Array.from({ length: 9 }, (_, i) => `http://cdn.example.org/${i}.mp4`) }, "https://www.rednote.com/x") as { urls: string[] }).urls.length, 3);
  });

  it("the platform class of a log line is one of a short list", () => {
    const seen = ["https://mp.weixin.qq.com/s?x=1", "https://www.xiaohongshu.com/a", "https://b23.tv/a", "https://www.bilibili.com/video/BV1", "https://weibo.com/tv/show/1", "https://v.qq.com/x/page/a.html", "https://www.douyin.com/video/1", "https://blog.example.org/a"].map(platformOf);
    assert.deepEqual(seen, ["wechat", "xiaohongshu", "bilibili", "bilibili", "weibo", "tencent", "douyin", "other"]);
  });
});

describe("the argument lists", () => {
  it("yt-dlp asked for the length: the proxy, nothing downloaded, one video, and the address after `--` so that it cannot be an option", () => {
    const args = ytdlpProbeArgs({ proxy: PROXY, page: "https://www.bilibili.com/video/BV1xx411c7mD" });
    assert.equal(args[args.indexOf("--proxy") + 1], PROXY);
    for (const flag of ["--ignore-config", "--no-cache-dir", "--no-playlist", "--dump-json", "--no-download"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--socket-timeout") + 1], "15");
    assert.deepEqual(args.slice(-2), ["--", "https://www.bilibili.com/video/BV1xx411c7mD"]);
    assert.ok(!args.includes("-o"), "nothing is written");
    // An address that looks like an option is still only an address.
    assert.deepEqual(ytdlpProbeArgs({ proxy: PROXY, page: "--exec=rm -rf /" }).slice(-2), ["--", "--exec=rm -rf /"]);
  });

  it("yt-dlp asked for the sound: the proxy, 150 MB, 15 seconds of silence, its own HLS and DASH downloaders, one file in the job's directory", () => {
    const args = ytdlpDownloadArgs({ proxy: PROXY, url: "http://cdn.example.org/a.mp4", dir: "/tmp/ke-runner-jobs/abc", referer: "https://www.xiaohongshu.com/" });
    assert.equal(args[args.indexOf("--proxy") + 1], PROXY);
    assert.equal(args[args.indexOf("--max-filesize") + 1], "150M");
    assert.equal(args[args.indexOf("--socket-timeout") + 1], "15");
    assert.equal(args[args.indexOf("--downloader") + 1], "dash,m3u8:native");
    assert.equal(args[args.indexOf("-f") + 1], "ba/b");
    assert.equal(args[args.indexOf("-o") + 1], "/tmp/ke-runner-jobs/abc/media.%(ext)s");
    assert.equal(args[args.indexOf("--add-headers") + 1], "Referer:https://www.xiaohongshu.com/");
    for (const flag of ["--ignore-config", "--no-playlist", "--restrict-filenames"]) assert.ok(args.includes(flag), flag);
    assert.deepEqual(args.slice(-2), ["--", "http://cdn.example.org/a.mp4"]);
    const plain = ytdlpDownloadArgs({ proxy: PROXY, url: "https://www.bilibili.com/video/BV1", dir: "/tmp/x" });
    assert.ok(!plain.includes("--add-headers") && !plain.includes("--ffmpeg-location"));
    assert.equal(ytdlpDownloadArgs({ proxy: PROXY, url: "https://a.example.org/", dir: "/tmp/x", ffmpeg: "/opt/ffmpeg/bin/ffmpeg" }).includes("/opt/ffmpeg/bin/ffmpeg"), true);
  });

  it("ffmpeg: the sound only, one channel, 16 kHz, Opus 24 kbit/s in an .ogg, and it may open nothing but the local file", () => {
    const args = ffmpegArgs({ input: "/tmp/ke-runner-jobs/abc/media.mp4", output: "/tmp/ke-runner-jobs/abc/audio.ogg" });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    assert.equal(at("-protocol_whitelist"), "file");
    assert.ok(args.indexOf("-protocol_whitelist") < args.indexOf("-i"), "the whitelist comes before the input");
    assert.equal(at("-i"), "file:/tmp/ke-runner-jobs/abc/media.mp4");
    assert.ok(args.includes("-vn"));
    assert.equal(at("-ac"), "1");
    assert.equal(at("-ar"), "16000");
    assert.equal(at("-c:a"), "libopus");
    assert.equal(at("-b:a"), "24k");
    assert.equal(args.at(-1), "file:/tmp/ke-runner-jobs/abc/audio.ogg");
    assert.ok(!args.some((a) => /^https?:|^ftp:|^tcp:/.test(a)));
  });
});

describe("running a program", () => {
  const node = (code: string, ...rest: string[]) => ["-e", code, ...rest];

  it("is an argument list, not a shell: what looks like a shell command is one argument", async () => {
    const out = await run(process.execPath, node("console.log(process.argv.slice(1).join('|'))", "a b; echo HACKED", "$(echo HACKED)", "`echo HACKED`"), { signal: idle, timeoutMs: 5000, capture: 1000 });
    assert.equal(out.code, 0);
    assert.equal(out.stdout.trim(), "a b; echo HACKED|$(echo HACKED)|`echo HACKED`");
  });

  it("gives a program the search path and the language, not this runner's own secrets", async () => {
    process.env.RUNNER_KEY = KEY;
    process.env.RUNNER_TRANSCRIBE_KEY = WORKER_KEY;
    try {
      const out = await run(process.execPath, node("console.log(JSON.stringify(Object.keys(process.env).filter((k) => /RUNNER/.test(k))))"), { signal: idle, timeoutMs: 5000, capture: 1000 });
      assert.equal(out.stdout.trim(), "[]");
      assert.ok(!("RUNNER_KEY" in childEnv()) && !("RUNNER_TRANSCRIBE_KEY" in childEnv()));
    } finally {
      delete process.env.RUNNER_KEY;
      delete process.env.RUNNER_TRANSCRIBE_KEY;
    }
  });

  it("stops at the time limit, at an abort, and at too much output; what it started is stopped with it", async () => {
    const forever = node("setTimeout(() => {}, 60000)");
    await assert.rejects(run(process.execPath, forever, { signal: idle, timeoutMs: 200 }), /timed out/);
    const ctl = new AbortController();
    const started = Date.now();
    const pending = run(process.execPath, forever, { signal: ctl.signal, timeoutMs: 30000 });
    setTimeout(() => ctl.abort(), 150);
    await assert.rejects(pending, /aborted/);
    assert.ok(Date.now() - started < 3000);
    await assert.rejects(run(process.execPath, node("console.log('x'.repeat(5000))"), { signal: idle, timeoutMs: 5000, capture: 1000 }), /too much output/);
    await assert.rejects(run(process.execPath, forever, { signal: AbortSignal.abort(), timeoutMs: 5000 }), /aborted/);

    // A program that starts another: the other is killed with it.
    const pidFile = join(tmp(), "pid");
    const parent = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); require('fs').writeFileSync(process.argv[1], String(c.pid)); setTimeout(() => {}, 60000)";
    const stop = new AbortController();
    const family = run(process.execPath, node(parent, pidFile), { signal: stop.signal, timeoutMs: 30000 });
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    const child = Number(readFileSync(pidFile, "utf8"));
    assert.ok(child > 0);
    stop.abort();
    await assert.rejects(family, /aborted/);
    const gone = async () => {
      for (let i = 0; i < 40; i++) {
        try {
          process.kill(child, 0);
        } catch {
          return true;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return false;
    };
    assert.ok(await gone(), "the program that was started by the program is still running");
  });

  it("an error never carries the arguments (they hold an address and the proxy's password) or what the program printed", async () => {
    const secretArgs = ["--proxy", PROXY, "--", "http://private-looking.example.org/secret-path"];
    const errors: string[] = [];
    for (const attempt of [
      () => run("/nonexistent/yt-dlp", secretArgs, { signal: idle, timeoutMs: 2000 }),
      () => run(process.execPath, ["-e", "console.log(process.argv[1]); setTimeout(() => {}, 60000)", "--", ...secretArgs], { signal: idle, timeoutMs: 150, capture: 100 }),
      () => run(process.execPath, ["-e", "console.log(process.argv.slice(1).join(' ').repeat(500))", "--", ...secretArgs], { signal: idle, timeoutMs: 2000, capture: 100 }),
      () => run(process.execPath, ["-e", "setTimeout(() => {}, 60000)", "--", ...secretArgs], { signal: AbortSignal.abort(), timeoutMs: 2000 }),
    ]) {
      try {
        await attempt();
      } catch (e) {
        errors.push(`${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
      }
    }
    assert.equal(errors.length, 4);
    for (const text of errors) for (const never of [PASSWORD, "user1", "private-looking", "secret-path", "127.0.0.1:41234"]) assert.ok(!text.includes(never), never);
  });
});

describe("the call to the transcription worker", () => {
  interface Seen {
    method?: string;
    url?: string;
    auth?: string;
    type?: string;
    body: Buffer;
  }
  const workers: http.Server[] = [];
  afterEach(() => {
    for (const w of workers.splice(0)) {
      w.close();
      w.closeAllConnections();
    }
  });
  async function worker(answer: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) });
        answer(req, res);
      });
    });
    workers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  const json = (status: number, body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const audio = () => {
    const file = join(tmp(), "audio.ogg");
    writeFileSync(file, Buffer.from("OggS-not-really-but-bytes\x00\x01\x02"));
    return file;
  };

  it("posts the audio with the key, and gives back the words", async () => {
    const w = await worker(json(200, { text: ` ${"今天讲泡茶"} `, speech: true, seconds: 12.5 }));
    const file = audio();
    const got = await transcribeFile({ url: w.url, bearer: WORKER_KEY }, file, idle);
    assert.deepEqual(got, { kind: "text", text: "今天讲泡茶" });
    assert.equal(w.seen.length, 1);
    assert.equal(w.seen[0].method, "POST");
    assert.equal(w.seen[0].url, "/transcribe?lang=auto");
    assert.equal(w.seen[0].auth, `Bearer ${WORKER_KEY}`);
    assert.deepEqual(w.seen[0].body, readFileSync(file));
  });

  it("no speech, or no words: no_speech; 413: too_long; at the most 30000 characters", async () => {
    const file = audio();
    assert.deepEqual(await transcribeFile({ url: (await worker(json(200, { text: "", speech: false, seconds: 9 }))).url, bearer: WORKER_KEY }, file, idle), { kind: "no_speech" });
    assert.deepEqual(await transcribeFile({ url: (await worker(json(200, { text: "嗯嗯嗯", speech: false, seconds: 9 }))).url, bearer: WORKER_KEY }, file, idle), { kind: "no_speech" });
    assert.deepEqual(await transcribeFile({ url: (await worker(json(200, { text: "   ", speech: true }))).url, bearer: WORKER_KEY }, file, idle), { kind: "no_speech" });
    assert.deepEqual(await transcribeFile({ url: (await worker(json(413, { error: "too_long" }))).url, bearer: WORKER_KEY }, file, idle), { kind: "too_long" });
    const long = await transcribeFile({ url: (await worker(json(200, { text: "茶".repeat(40000), speech: true }))).url, bearer: WORKER_KEY }, file, idle);
    assert.ok(long.kind === "text" && [...long.text].length === 30000);
  });

  it("anything else is a failure, and no failure says the key: busy, refused, broken, not JSON, a redirect, silent past the time, aborted, not there", async () => {
    const file = audio();
    const failures: (() => Promise<unknown>)[] = [];
    for (const status of [503, 401, 500, 404, 204]) {
      const w = await worker(json(status, { error: "nope" }));
      failures.push(() => transcribeFile({ url: w.url, bearer: WORKER_KEY }, file, idle));
    }
    const text = await worker((_req, res) => res.end("not json"));
    failures.push(() => transcribeFile({ url: text.url, bearer: WORKER_KEY }, file, idle));
    const moved = await worker((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/elsewhere" });
      res.end();
    });
    failures.push(() => transcribeFile({ url: moved.url, bearer: WORKER_KEY }, file, idle));
    const silent = await worker(() => {});
    failures.push(() => transcribeFile({ url: silent.url, bearer: WORKER_KEY, timeoutMs: 200 }, file, idle));
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 100);
    failures.push(() => transcribeFile({ url: silent.url, bearer: WORKER_KEY }, file, ctl.signal));
    failures.push(() => transcribeFile({ url: "http://127.0.0.1:9", bearer: WORKER_KEY }, file, idle));
    failures.push(() => transcribeFile({ url: silent.url, bearer: WORKER_KEY }, join(tmp(), "missing.ogg"), idle));
    for (const attempt of failures) {
      await assert.rejects(attempt, (e: Error) => {
        const said = `${e.message} ${e.stack} ${JSON.stringify(e, Object.getOwnPropertyNames(e))} ${String((e as { cause?: unknown }).cause)}`;
        return !said.includes(WORKER_KEY);
      });
    }
  });
});

describe("the settings", () => {
  const base = { RUNNER_KEY: KEY };
  it("have the defaults of the brief, and take their variables", () => {
    const cfg = loadConfig(base);
    assert.deepEqual([cfg.videoMaxMinutes, cfg.videoConcurrency, cfg.videoQueue, cfg.ytdlp, cfg.ffmpeg, cfg.transcribeUrl, cfg.transcribeKey], [15, 1, 4, "yt-dlp", "ffmpeg", undefined, ""]);
    const set = loadConfig({ ...base, RUNNER_VIDEO_MAX_MINUTES: "10", RUNNER_VIDEO_CONCURRENCY: "2", RUNNER_VIDEO_QUEUE: "6", RUNNER_YTDLP: "/opt/yt-dlp", RUNNER_FFMPEG: "/opt/ffmpeg", RUNNER_TRANSCRIBE_URL: "http://ms.tailnet.example:8830/", RUNNER_TRANSCRIBE_KEY: WORKER_KEY });
    assert.deepEqual([set.videoMaxMinutes, set.videoConcurrency, set.videoQueue, set.ytdlp, set.ffmpeg, set.transcribeUrl, set.transcribeKey], [10, 2, 6, "/opt/yt-dlp", "/opt/ffmpeg", "http://ms.tailnet.example:8830", WORKER_KEY]);
  });

  it("a worker address that is not an address, or has no key, stops the start instead of reading nothing", () => {
    assert.throws(() => loadConfig({ ...base, RUNNER_TRANSCRIBE_URL: "ms:8830", RUNNER_TRANSCRIBE_KEY: WORKER_KEY }), /RUNNER_TRANSCRIBE_URL/);
    assert.throws(() => loadConfig({ ...base, RUNNER_TRANSCRIBE_URL: "ftp://ms/", RUNNER_TRANSCRIBE_KEY: WORKER_KEY }), /RUNNER_TRANSCRIBE_URL/);
    assert.throws(() => loadConfig({ ...base, RUNNER_TRANSCRIBE_URL: "http://ms:8830" }), /RUNNER_TRANSCRIBE_KEY/);
  });
});

// ---------------------------------------------------------------- the real programs (optional)

const have = (cmd: string, arg: string) => spawnSync(cmd, [arg], { stdio: "ignore" }).status === 0;
const programs = have("yt-dlp", "--version") && have("ffmpeg", "-version");

describe("the real yt-dlp and ffmpeg, through the real proxy, over a made-up network", { skip: !programs && "yt-dlp and ffmpeg are not both installed" }, () => {
  it("a video is downloaded by its address through the proxy, its sound is taken out, and nothing is left; an address the proxy refuses is not reached", async () => {
    const work = tmp();
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=2:r=10", "-c:v", "mpeg4", "-c:a", "aac", "-shortest", join(work, "clip.mp4")]);
    const clip = readFileSync(join(work, "clip.mp4"));
    const s = await start(
      {
        "http://media.example.org/clip.mp4": () => ({ status: 200, headers: { "content-type": "video/mp4", "content-length": String(clip.length) }, body: clip }),
        "http://internal.example.org/clip.mp4": () => ({ status: 200, headers: { "content-type": "video/mp4" }, body: clip }),
      },
      { privateNames: ["internal.example.org"] },
    );
    try {
      const pipeline = createPipeline(s.cfg, s.proxy);
      const dir = join(work, "job");
      execFileSync("mkdir", [dir]);
      const file = await pipeline.download({ kind: "direct", urls: ["http://media.example.org/clip.mp4"], seconds: 2, referer: "http://media.example.org/" }, dir, idle);
      assert.match(file, /media\.mp4$/);
      assert.deepEqual(readFileSync(file), clip);
      assert.ok(s.hits.some((h) => h.url === "http://media.example.org/clip.mp4"), "the made-up network was asked through the proxy");
      const audio = await pipeline.extractAudio(file, dir, idle);
      assert.match(audio, /audio\.ogg$/);
      assert.equal(readFileSync(audio).subarray(0, 4).toString(), "OggS");
      assert.equal(s.proxy.openReads(), 0, "a read of the proxy was left open");

      // A name that leads to a private address: the proxy refuses, and the made-up network is not asked.
      const other = join(work, "other");
      execFileSync("mkdir", [other]);
      const before = s.hits.length;
      await assert.rejects(pipeline.download({ kind: "direct", urls: ["http://internal.example.org/clip.mp4"], seconds: 2, referer: "http://internal.example.org/" }, other, idle), /no media/);
      assert.equal(s.hits.length, before);
      assert.deepEqual(readdirSync(other), []);
      // An address that is not public is never given to yt-dlp at all.
      await assert.rejects(pipeline.download({ kind: "direct", urls: ["http://127.0.0.1:9/clip.mp4"], seconds: 2, referer: "http://x.example.org/" }, other, idle), /no media/);
      assert.equal(s.proxy.openReads(), 0);
      // A file that is not media: ffmpeg says so, and the job is "unavailable" (jobs.ts).
      writeFileSync(join(other, "media.mp4"), "not a video");
      await assert.rejects(pipeline.extractAudio(join(other, "media.mp4"), other, idle));
    } finally {
      await s.close();
    }
  });
});
