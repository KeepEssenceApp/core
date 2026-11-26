// #103: the cool-down for a site that refuses a download: its parts, with no network and no real yt-dlp.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { COOLDOWN_STATUSES, createCooldown } from "../src/cooldown.ts";
import { siteOfRef } from "../src/detect.ts";
import { run } from "../src/exec.ts";
import { createPipeline, Refused, type MediaRef } from "../src/media.ts";
import { FilteringProxy } from "../src/proxy.ts";
import { KEY } from "./helpers.ts";

const idle = new AbortController().signal;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cooldown-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the cool-down", () => {
  it("is a site's name and a time: active until its time is up, then forgotten", () => {
    let t = 5000;
    const c = createCooldown(1000, () => t);
    assert.equal(c.active("bilibili.com"), null);
    c.start("bilibili.com");
    assert.equal(c.active("bilibili.com"), 1000);
    t += 400;
    assert.equal(c.active("bilibili.com"), 600);
    assert.equal(c.active("xiaohongshu.com"), null);
    t += 600;
    assert.equal(c.active("bilibili.com"), null);
    t += 10;
    assert.equal(c.active("bilibili.com"), null);
  });

  it("is nothing at 0 and nothing for a time that is not a time; the statuses are 567, 412 and 429", () => {
    for (const ms of [0, -5, Number.NaN]) {
      const c = createCooldown(ms);
      c.start("a.com");
      assert.equal(c.active("a.com"), null, String(ms));
    }
    assert.deepEqual([...COOLDOWN_STATUSES].sort(), [412, 429, 567]);
  });

  it("holds at most a hundred sites, and an expired one makes room", () => {
    let t = 0;
    const c = createCooldown(1000, () => t);
    for (let i = 0; i < 150; i++) c.start(`site${i}.example`);
    assert.equal(c.active("site0.example"), 1000);
    assert.equal(c.active("site120.example"), null);
    t += 2000;
    c.start("fresh.example");
    assert.equal(c.active("fresh.example"), 1000);
  });
});

describe("which site a video belongs to", () => {
  it("is the site's own name, www or not, whatever address it came by", () => {
    const page = (p: string) => ({ kind: "page" as const, page: p });
    assert.equal(siteOfRef(page("https://www.bilibili.com/video/BV1xx411c7mD")), "bilibili.com");
    assert.equal(siteOfRef(page("https://m.bilibili.com/video/BV1xx411c7mD?site=OVERSEAS")), "bilibili.com");
    assert.equal(siteOfRef(page("https://b23.tv/AbCdEf")), "bilibili.com");
    assert.equal(siteOfRef(page("https://v.qq.com/x/page/abc.html")), "qq.com");
    assert.equal(siteOfRef(page("https://www.example.co.uk/v/1")), "example.co.uk");
    assert.equal(siteOfRef({ kind: "direct", urls: ["https://sns-video.example.net/a.mp4"], seconds: 9, referer: "https://www.xiaohongshu.com/" }), "xiaohongshu.com");
    assert.equal(siteOfRef({ kind: "unsupported" }), null);
    assert.equal(siteOfRef(page("not an address")), null);
    assert.equal(siteOfRef(page("http://localhost/x")), null);
  });
});

describe("the setting", () => {
  it("is six hours unless the variable says another number of hours; 0 is none, and a mistake is the default", () => {
    const hours = (v: string | undefined) => loadConfig({ RUNNER_KEY: KEY, ...(v === undefined ? {} : { RUNNER_VIDEO_COOLDOWN_HOURS: v }) }).videoCooldownMs / 3600000;
    assert.equal(hours(undefined), 6);
    assert.equal(hours("2"), 2);
    assert.equal(hours("0.5"), 0.5);
    assert.equal(hours("0"), 0);
    for (const bad of ["", "abc", "-1", "NaN"]) assert.equal(hours(bad), 6, bad);
  });
});

describe("reading a program's trouble", () => {
  const node = (code: string) => ["-e", code];

  it("gives back the number of an HTTP error and nothing else of what the program said", async () => {
    const out = await run(process.execPath, node("process.stderr.write('ERROR: [x] unable to download video data from https://cdn.example.org/secret?k=1: HTTP Error 567: \\n'); process.exit(1)"), { signal: idle, timeoutMs: 5000, watchStatus: true });
    assert.equal(out.code, 1);
    assert.equal(out.status, 567);
    assert.ok(!JSON.stringify(out).includes("secret") && !JSON.stringify(out).includes("cdn.example.org"));
  });

  it("finds it when the message is cut between two writes; none when there is none, or when it was not asked for", async () => {
    const cut = await run(process.execPath, node("process.stderr.write('ERROR: HTTP Er'); setTimeout(() => { process.stderr.write('ror 412: Precondition Failed'); process.exit(1) }, 100)"), { signal: idle, timeoutMs: 5000, watchStatus: true });
    assert.equal(cut.status, 412);
    const none = await run(process.execPath, node("process.stderr.write('ERROR: nothing about a status'); process.exit(1)"), { signal: idle, timeoutMs: 5000, watchStatus: true });
    assert.equal(none.status, null);
    const unasked = await run(process.execPath, node("process.stderr.write('HTTP Error 567'); process.exit(1)"), { signal: idle, timeoutMs: 5000 });
    assert.equal(unasked.status, null);
  });
});

describe("the real steps with a yt-dlp that is refused", () => {
  /** A made-up yt-dlp that says what it is told to, and writes down that it was run. */
  function fakeYtdlp(says: string) {
    const dir = tmp();
    const file = join(dir, "yt-dlp");
    writeFileSync(file, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(dir, "runs"))}, 'run\\n');\nprocess.stderr.write(${JSON.stringify(says)});\nprocess.exit(1);\n`);
    chmodSync(file, 0o755);
    return { file, runs: () => { try { return readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length; } catch { return 0; } }, dir };
  }
  async function pipeline(ytdlp: string) {
    const proxy = new FilteringProxy();
    await proxy.listen();
    return { pipe: createPipeline(loadConfig({ RUNNER_KEY: KEY, RUNNER_YTDLP: ytdlp }), proxy), done: () => proxy.close() };
  }

  it("a 567 while downloading is a refusal, and the next address of the same video is not tried", async () => {
    const y = fakeYtdlp("ERROR: unable to download video data: HTTP Error 567: ");
    const p = await pipeline(y.file);
    try {
      const ref: MediaRef = { kind: "direct", urls: ["https://cdn.example.org/a.mp4", "https://cdn.example.org/b.mp4"], seconds: 60, referer: "https://www.xiaohongshu.com/" };
      await assert.rejects(p.pipe.download(ref, y.dir, idle), (e: unknown) => e instanceof Refused && e.status === 567);
      assert.equal(y.runs(), 1);
    } finally {
      await p.done();
    }
  });

  it("a 412 while asking the length is a refusal; a 404, or nothing said, is only a video that is not found", async () => {
    for (const [says, refused] of [["ERROR: HTTP Error 412: Precondition Failed", true], ["ERROR: HTTP Error 429: Too Many Requests", true], ["ERROR: HTTP Error 404: Not Found", false], ["ERROR: something else", false]] as const) {
      const y = fakeYtdlp(says);
      const p = await pipeline(y.file);
      try {
        if (refused) await assert.rejects(p.pipe.probe("https://www.bilibili.com/video/BV1xx411c7mD", idle), (e: unknown) => e instanceof Refused);
        else assert.equal(await p.pipe.probe("https://www.bilibili.com/video/BV1xx411c7mD", idle), null, says);
      } finally {
        await p.done();
      }
    }
  });

  it("a download that fails for another reason is the old plain failure, and the next address is tried", async () => {
    const y = fakeYtdlp("ERROR: HTTP Error 404: Not Found");
    const p = await pipeline(y.file);
    try {
      const ref: MediaRef = { kind: "direct", urls: ["https://cdn.example.org/a.mp4", "https://cdn.example.org/b.mp4"], seconds: 60, referer: "https://www.xiaohongshu.com/" };
      await assert.rejects(p.pipe.download(ref, y.dir, idle), (e: unknown) => !(e instanceof Refused) && /no media/.test(String((e as Error).message)));
      assert.equal(y.runs(), 2);
    } finally {
      await p.done();
    }
  });
});
