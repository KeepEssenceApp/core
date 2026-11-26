// #103: the video jobs, with made-up media steps (no network, no yt-dlp, no ffmpeg, no browser).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { VideoRef } from "../src/detect.ts";
import { createJobs, type Jobs, type JobsOptions } from "../src/jobs.ts";
import { Refused, type MediaRef, type Pipeline } from "../src/media.ts";
import { fakes, SAID } from "./helpers.ts";

const ADDRESS = "http://cdn.example.org/secret-video-path/clip.mp4";
const PAGE = "https://www.bilibili.com/video/BV1xx411c7mD";
const direct = (seconds: number | null = 111, urls: string[] = [ADDRESS]): VideoRef => ({ kind: "direct", urls, seconds, referer: "https://www.xiaohongshu.com/" });
const page: VideoRef = { kind: "page", page: PAGE };
const idle = new AbortController().signal;

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  return ok();
};
/** A promise that a test opens when it wants the step to go on. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};
/** Rejects when the signal aborts: what the real steps do (their program is killed). */
const untilAborted = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

let roots: string[] = [];
let live: Jobs[] = [];
afterEach(async () => {
  for (const j of live) await j.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
  live = [];
});

function setup(over: Partial<JobsOptions> = {}, pipeline: Partial<Pipeline> = {}) {
  const base = mkdtempSync(join(tmpdir(), "jobs-test-"));
  roots.push(base);
  const root = join(base, "jobs");
  const logs: string[] = [];
  const fk = fakes(pipeline);
  const jobs = createJobs({ ...fk.pipeline, enabled: true, maxSeconds: 900, concurrency: 1, queue: 4, root, log: (l) => logs.push(l), ...over });
  live.push(jobs);
  return { jobs, root, logs, calls: fk.calls };
}

describe("the life of a job", () => {
  it("is reading, and then done with the words; its files are there while it runs and gone at the end", async () => {
    const hold = gate();
    const seen: { media: boolean; audio: boolean; dir: string }[] = [];
    const s = setup({}, {
      transcribe: async (audio) => {
        // The video is not kept while the words are waited for; the sound is, until the words are back.
        seen.push({ media: existsSync(join(dirname(audio), "media.mp4")), audio: existsSync(audio), dir: dirname(audio) });
        await hold.opened;
        return { kind: "text", text: SAID };
      },
    });
    const a = await s.jobs.start(direct(), "xiaohongshu", idle);
    assert.ok(a.state === "reading" && /^[0-9a-f]{24,}$/.test(a.job) && a.seconds === 111);
    const id = (a as { job: string }).job;
    assert.ok(await until(() => seen.length === 1));
    assert.deepEqual(s.jobs.get(id), { state: "reading" });
    assert.deepEqual({ media: seen[0].media, audio: seen[0].audio }, { media: false, audio: true });
    assert.ok(seen[0].dir.startsWith(s.root));
    hold.open();
    assert.ok(await until(() => s.jobs.get(id)?.state === "done"));
    assert.deepEqual(s.jobs.get(id), { state: "done", video_state: "recognized", recognized_text: SAID });
    assert.deepEqual(readdirSync(s.root), [], "a file was left");
  });

  it("nothing is said: no_speech, with no words; the worker says too long: too_long", async () => {
    const quiet = setup({}, { transcribe: async () => ({ kind: "no_speech" }) });
    const q = await quiet.jobs.start(direct(), "xiaohongshu", idle);
    assert.ok(await until(() => quiet.jobs.get((q as { job: string }).job)?.state === "done"));
    assert.deepEqual(quiet.jobs.get((q as { job: string }).job), { state: "done", video_state: "no_speech" });
    const long = setup({}, { transcribe: async () => ({ kind: "too_long" }) });
    const l = await long.jobs.start(direct(), "xiaohongshu", idle);
    assert.ok(await until(() => long.jobs.get((l as { job: string }).job)?.state === "done"));
    assert.deepEqual(long.jobs.get((l as { job: string }).job), { state: "done", video_state: "too_long" });
  });

  it("a media page is asked for its length first; a direct video's length is the one its page said", async () => {
    const s = setup();
    const a = await s.jobs.start(page, "bilibili", idle);
    assert.ok(a.state === "reading" && a.seconds === 120);
    assert.deepEqual(s.calls.probe, [PAGE]);
    const b = await s.jobs.start(direct(77), "xiaohongshu", idle);
    assert.ok(b.state === "reading" && b.seconds === 77);
    assert.deepEqual(s.calls.probe, [PAGE], "a direct video is not asked about");
    assert.ok(await until(() => s.calls.download.length === 2));
  });
});

describe("what is not read", () => {
  it("a video over the limit is too_long and is never downloaded; the limit itself is read", async () => {
    const s = setup();
    assert.deepEqual(await s.jobs.start(direct(901), "xiaohongshu", idle), { state: "too_long", seconds: 901 });
    const probed = setup({}, { probe: async () => 3600 });
    assert.deepEqual(await probed.jobs.start(page, "bilibili", idle), { state: "too_long", seconds: 3600 });
    assert.equal(s.calls.download.length + probed.calls.download.length, 0);
    assert.deepEqual([...s.jobs.retained(), ...probed.jobs.retained()], []);
    const exact = await s.jobs.start(direct(900), "xiaohongshu", idle);
    assert.equal(exact.state, "reading");
  });

  it("unavailable: reading is not set up, the platform cannot be read, the length or the address cannot be found", async () => {
    const off = setup({ enabled: false });
    assert.deepEqual(await off.jobs.start(direct(), "xiaohongshu", idle), { state: "unavailable", seconds: 111 });
    assert.deepEqual(await off.jobs.start(page, "bilibili", idle), { state: "unavailable", seconds: null });
    assert.equal(off.calls.probe.length, 0, "nothing is asked when nothing can be read");
    const on = setup();
    assert.deepEqual(await on.jobs.start({ kind: "unsupported" }, "wechat", idle), { state: "unavailable", seconds: null });
    assert.deepEqual(await on.jobs.start(direct(111, []), "xiaohongshu", idle), { state: "unavailable", seconds: 111 }, "no media address");
    assert.deepEqual(await on.jobs.start(direct(null), "xiaohongshu", idle), { state: "unavailable", seconds: null }, "no length");
    const none = setup({}, { probe: async () => null });
    assert.deepEqual(await none.jobs.start(page, "bilibili", idle), { state: "unavailable", seconds: null });
    const broken = setup({}, { probe: async () => Promise.reject(new Error("yt-dlp failed")) });
    assert.deepEqual(await broken.jobs.start(page, "bilibili", idle), { state: "unavailable", seconds: null });
    assert.equal(on.calls.download.length, 0);
  });

  it("one running and four waiting; the sixth is unavailable at once, and a place that is freed is taken again", async () => {
    const hold = gate();
    let active = 0;
    let most = 0;
    const order: string[] = [];
    const s = setup({}, {
      download: async (ref: MediaRef, dir: string) => {
        active++;
        most = Math.max(most, active);
        order.push(ref.kind === "direct" ? ref.urls[0] : "");
        await hold.opened;
        active--;
        const file = join(dir, "media.mp4");
        await writeFile(file, "video");
        return file;
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await s.jobs.start(direct(60, [`http://cdn.example.org/${i}.mp4`]), "xiaohongshu", idle);
      assert.equal(a.state, "reading", `job ${i}`);
      ids.push((a as { job: string }).job);
    }
    assert.ok(await until(() => order.length === 1));
    const started = Date.now();
    assert.deepEqual(await s.jobs.start(direct(60), "xiaohongshu", idle), { state: "unavailable", seconds: 60 });
    assert.ok(Date.now() - started < 500);
    assert.equal(order.length, 1, "only one runs at a time");
    for (const id of ids) assert.deepEqual(s.jobs.get(id), { state: "reading" });
    hold.open();
    assert.ok(await until(() => ids.every((id) => s.jobs.get(id)?.state === "done")));
    assert.equal(most, 1);
    assert.deepEqual(order, [0, 1, 2, 3, 4].map((i) => `http://cdn.example.org/${i}.mp4`), "in the order they came");
    assert.equal((await s.jobs.start(direct(60), "xiaohongshu", idle)).state, "reading");
  });

  it("the number running at once is the setting's", async () => {
    const hold = gate();
    let active = 0;
    let most = 0;
    const s = setup({ concurrency: 2, queue: 1 }, {
      download: async (_ref: MediaRef, dir: string) => {
        active++;
        most = Math.max(most, active);
        await hold.opened;
        active--;
        const file = join(dir, "media.mp4");
        await writeFile(file, "video");
        return file;
      },
    });
    const states = [];
    for (let i = 0; i < 4; i++) states.push((await s.jobs.start(direct(), "xiaohongshu", idle)).state);
    assert.deepEqual(states, ["reading", "reading", "reading", "unavailable"]);
    assert.ok(await until(() => most === 2));
    hold.open();
    assert.ok(await until(() => s.jobs.retained().every((j) => (j as { state: string }).state === "done")));
    assert.equal(most, 2);
  });
});

describe("cancel, the deadline and clean-up", () => {
  it("cancelling a running job stops its download, removes its files and forgets it; the place goes on to the next", async () => {
    let aborted = false;
    let running = false;
    let dir = "";
    const second = gate();
    const s = setup({}, {
      download: async (ref: MediaRef, d: string, signal: AbortSignal) => {
        if (ref.kind === "direct" && ref.urls[0].endsWith("/two.mp4")) {
          await second.opened;
          const file = join(d, "media.mp4");
          await writeFile(file, "video");
          return file;
        }
        dir = d;
        await writeFile(join(d, "media.mp4.part"), "half of a video");
        running = true;
        return untilAborted(signal).catch((e) => {
          aborted = signal.aborted;
          throw e;
        });
      },
    });
    const a = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    const b = (await s.jobs.start(direct(60, ["http://cdn.example.org/two.mp4"]), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => running));
    assert.ok(existsSync(dir));
    await s.jobs.cancel(a.job);
    assert.ok(aborted, "the download did not see the abort");
    assert.equal(existsSync(dir), false, "files are left");
    assert.equal(s.jobs.get(a.job), null);
    assert.deepEqual(s.jobs.get(b.job), { state: "reading" }, "the next one runs now");
    second.open();
    assert.ok(await until(() => s.jobs.get(b.job)?.state === "done"));
    assert.deepEqual(readdirSync(s.root), []);
  });

  it("cancelling a job that waits: it never runs, and the others do", async () => {
    const hold = gate();
    const downloaded: MediaRef[] = [];
    const s = setup({}, {
      download: async (ref: MediaRef, dir: string) => {
        await hold.opened;
        const file = join(dir, "media.mp4");
        await writeFile(file, "video");
        downloaded.push(ref);
        return file;
      },
    });
    const a = (await s.jobs.start(direct(60, ["http://cdn.example.org/a.mp4"]), "xiaohongshu", idle)) as { job: string };
    const b = (await s.jobs.start(direct(60, ["http://cdn.example.org/b.mp4"]), "xiaohongshu", idle)) as { job: string };
    const c = (await s.jobs.start(direct(60, ["http://cdn.example.org/c.mp4"]), "xiaohongshu", idle)) as { job: string };
    await s.jobs.cancel(b.job);
    assert.equal(s.jobs.get(b.job), null);
    hold.open();
    assert.ok(await until(() => s.jobs.get(a.job)?.state === "done" && s.jobs.get(c.job)?.state === "done"));
    assert.deepEqual(downloaded.map((r) => (r.kind === "direct" ? r.urls[0].slice(-6) : "")), ["/a.mp4", "/c.mp4"]);
    assert.equal(s.jobs.get(b.job), null);
  });

  it("cancelling a finished job forgets its result; cancelling what is not known is nothing", async () => {
    const s = setup();
    const a = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => s.jobs.get(a.job)?.state === "done"));
    await s.jobs.cancel(a.job);
    assert.equal(s.jobs.get(a.job), null);
    await s.jobs.cancel(a.job);
    await s.jobs.cancel("0".repeat(32));
    await s.jobs.cancel("../../etc");
    assert.deepEqual(s.jobs.retained(), []);
  });

  it("the deadline is for all the steps together: a step that obeys the abort, and one that does not, both end as unavailable with the files gone", async () => {
    const obeys = setup({ deadlineMs: 150 }, { download: async (_r: MediaRef, d: string, signal: AbortSignal) => (await writeFile(join(d, "media.mp4.part"), "x"), untilAborted(signal)) });
    const a = (await obeys.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => obeys.jobs.get(a.job)?.state === "done"));
    assert.deepEqual(obeys.jobs.get(a.job), { state: "done", video_state: "unavailable" });
    assert.deepEqual(readdirSync(obeys.root), []);
    assert.equal(JSON.parse(obeys.logs.at(-1)!).stage, "deadline");

    const ignores = setup({ deadlineMs: 150 }, { transcribe: () => new Promise(() => {}) });
    const b = (await ignores.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => ignores.jobs.get(b.job)?.state === "done"));
    assert.deepEqual(ignores.jobs.get(b.job), { state: "done", video_state: "unavailable" });
    assert.deepEqual(readdirSync(ignores.root), []);
  });

  it("the deadline counts from when a job runs, not from when it waited", async () => {
    const s = setup({ deadlineMs: 300 }, { download: async (_r: MediaRef, d: string) => (await new Promise((r) => setTimeout(r, 200)), writeFile(join(d, "media.mp4"), "v").then(() => join(d, "media.mp4"))) });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(((await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string }).job);
    assert.ok(await until(() => ids.every((id) => s.jobs.get(id)?.state === "done"), 5000));
    assert.deepEqual(ids.map((id) => (s.jobs.get(id) as { video_state: string }).video_state), ["recognized", "recognized", "recognized"]);
  });

  it("a step that throws, at any of the three, leaves nothing behind: unavailable, and the directory is gone", async () => {
    const boom = () => Promise.reject(new Error("boom"));
    const cases: [string, Partial<Pipeline>][] = [
      ["download", { download: async (_r: MediaRef, d: string) => (await writeFile(join(d, "media.mp4.part"), "x"), boom()) }],
      ["extract", { extractAudio: async (_f: string, d: string) => (await writeFile(join(d, "audio.ogg"), "x"), boom()) }],
      ["transcribe", { transcribe: boom }],
    ];
    for (const [stage, pipeline] of cases) {
      const s = setup({}, pipeline);
      const a = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
      assert.ok(await until(() => s.jobs.get(a.job)?.state === "done"), stage);
      assert.deepEqual(s.jobs.get(a.job), { state: "done", video_state: "unavailable" }, stage);
      assert.deepEqual(readdirSync(s.root), [], stage);
      assert.equal(JSON.parse(s.logs.at(-1)!).stage, stage);
    }
  });

  it("what an earlier run left is removed at start-up", async () => {
    const base = mkdtempSync(join(tmpdir(), "jobs-test-"));
    roots.push(base);
    const root = join(base, "jobs");
    mkdirSync(join(root, "0123456789abcdef0123456789abcdef"), { recursive: true });
    writeFileSync(join(root, "0123456789abcdef0123456789abcdef", "media.mp4"), "left over");
    writeFileSync(join(root, "stray"), "left over");
    const jobs = createJobs({ ...fakes().pipeline, enabled: true, maxSeconds: 900, concurrency: 1, queue: 4, root, log: () => {} });
    live.push(jobs);
    await jobs.ready;
    assert.deepEqual(readdirSync(root), []);
  });

  it("closing (the runner stops) stops what is running and removes every file", async () => {
    let aborted = false;
    let running = false;
    const s = setup({}, {
      download: async (_r: MediaRef, d: string, signal: AbortSignal) => {
        await writeFile(join(d, "media.mp4.part"), "x");
        running = true;
        return untilAborted(signal).catch((e) => {
          aborted = true;
          throw e;
        });
      },
    });
    await s.jobs.start(direct(), "xiaohongshu", idle);
    await s.jobs.start(direct(), "xiaohongshu", idle);
    assert.ok(await until(() => running));
    await s.jobs.close();
    assert.ok(aborted);
    assert.equal(existsSync(s.root), false);
  });
});

describe("what is kept", () => {
  it("a result is kept for 30 minutes after it is done and then forgotten; a job still reading is not", async () => {
    let t = 1_000_000;
    let calls = 0;
    const hold = gate();
    const s = setup({ now: () => t }, {
      transcribe: async (_a: string) => {
        if (calls++ === 1) await hold.opened;
        return { kind: "text", text: SAID };
      },
    });
    const done = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => s.jobs.get(done.job)?.state === "done"));
    const reading = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => calls === 2));
    t += 30 * 60 * 1000 - 1;
    assert.equal(s.jobs.get(done.job)?.state, "done");
    t += 1;
    assert.equal(s.jobs.get(done.job), null, "forgotten at 30 minutes");
    t += 3 * 60 * 60 * 1000;
    assert.deepEqual(s.jobs.get(reading.job), { state: "reading" });
    hold.open();
    assert.ok(await until(() => s.jobs.get(reading.job)?.state === "done"));
    assert.equal(s.jobs.get(reading.job)?.state, "done", "its 30 minutes start when it is done");
    assert.equal(s.jobs.retained().length, 1);
  });

  it("an id that is not known, or not an id, is not found", async () => {
    const s = setup();
    for (const id of ["", "x", "0".repeat(32), "../../etc/passwd", "0123456789abcdef0123456789abcdef/../..", "A".repeat(32)]) assert.equal(s.jobs.get(id), null, id);
  });

  it("nothing keeps the address once the job is over; the result is only the state and the words", async () => {
    const s = setup();
    const a = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => s.jobs.get(a.job)?.state === "done"));
    const after = JSON.stringify(s.jobs.retained());
    for (const never of ["secret-video-path", "cdn.example.org", "xiaohongshu.com", ".mp4"]) assert.ok(!after.includes(never), never);
    assert.deepEqual(JSON.parse(after).map((j: { result: unknown }) => j.result), [{ video_state: "recognized", recognized_text: SAID }]);
  });

  it("the log says how it went and for how long, and never an address, a job, or a word of what was said", async () => {
    let hanging = false;
    const s = setup({}, {
      download: async (ref: MediaRef, d: string, signal: AbortSignal) => {
        if (ref.kind === "direct" && ref.urls[0].endsWith("/hang.mp4")) {
          hanging = true;
          return untilAborted(signal);
        }
        const file = join(d, "media.mp4");
        await writeFile(file, "video");
        return file;
      },
    });
    const a = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    const b = (await s.jobs.start(direct(), "xiaohongshu", idle)) as { job: string };
    const c = (await s.jobs.start(direct(60, ["http://cdn.example.org/secret-video-path/hang.mp4"]), "xiaohongshu", idle)) as { job: string };
    assert.ok(await until(() => s.jobs.get(a.job)?.state === "done" && s.jobs.get(b.job)?.state === "done" && hanging));
    await s.jobs.cancel(c.job);
    const text = s.logs.join("\n");
    for (const never of [a.job, b.job, c.job, "cdn.example.org", "secret-video-path", ".mp4", "http", "泡", "茶", SAID]) assert.ok(!text.includes(never), never);
    for (const line of s.logs) {
      const fields = JSON.parse(line);
      assert.deepEqual(Object.keys(fields).filter((k) => !["at", "result", "video_state", "stage", "platform", "ms"].includes(k)), []);
    }
    assert.deepEqual(s.logs.map((l) => JSON.parse(l).result), ["video_done", "video_done", "video_cancelled"]);
  });
});

describe("a site that refuses the download is left alone for a while", () => {
  const HOURS = 3600 * 1000;
  /** Downloads that are refused, and how many were asked for. */
  let asked = 0;
  const refusing = (status = 567): Partial<Pipeline> => ({
    download: async () => {
      asked++;
      throw new Refused(status);
    },
  });
  beforeEach(() => {
    asked = 0;
  });
  /** A clock the test moves. */
  const clock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };
  const finished = async (s: ReturnType<typeof setup>, id: string) => {
    assert.ok(await until(() => s.jobs.get(id)?.state === "done"), "the job did not end");
    return s.jobs.get(id);
  };

  it("after a 567 the site's videos are unavailable at once, with nothing probed and nothing downloaded; other sites go on; after the cool-down it asks again", async () => {
    const c = clock();
    const s = setup({ cooldownMs: 6 * HOURS, now: c.now }, refusing());
    const first = await s.jobs.start(page, "other", idle);
    assert.ok(first.state === "reading");
    assert.deepEqual(await finished(s, first.job), { state: "done", video_state: "unavailable" });
    assert.equal(s.calls.probe.length, 1);
    assert.equal(s.calls.extract + s.calls.transcribe, 0);

    // The same site, a minute and then five hours later: told at once, and not asked.
    for (const later of [60 * 1000, 5 * HOURS - 60 * 1000]) {
      c.advance(later);
      assert.deepEqual(await s.jobs.start(page, "other", idle), { state: "unavailable", seconds: null });
    }
    assert.equal(s.calls.probe.length, 1, "the site was probed during its cool-down");
    assert.equal(asked, 1, "the site was downloaded from during its cool-down");
    assert.deepEqual(s.jobs.retained().filter((j) => (j as { state: string }).state !== "done"), []);

    // Another site is another site.
    const other = await s.jobs.start(direct(), "xiaohongshu", idle);
    assert.equal(other.state, "reading");

    // Six hours after the refusal: the site is asked again.
    c.advance(HOURS + 60 * 1000);
    const again = await s.jobs.start(page, "other", idle);
    assert.equal(again.state, "reading");
    assert.equal(s.calls.probe.length, 2);
  });

  it("412 and 429 are refusals too; 404 or any other failure is not", async () => {
    for (const [status, cools] of [[412, true], [429, true], [567, true]] as const) {
      const s = setup({ cooldownMs: HOURS }, refusing(status));
      const a = await s.jobs.start(page, "other", idle);
      assert.ok(a.state === "reading");
      await finished(s, a.job);
      assert.equal((await s.jobs.start(page, "other", idle)).state === "unavailable", cools, String(status));
    }
    // A failure that is not the site's refusal: the next video is asked about as usual.
    const plain = setup({ cooldownMs: HOURS }, { download: async () => { throw new Error("no media was downloaded"); } });
    const a = await plain.jobs.start(page, "other", idle);
    assert.ok(a.state === "reading");
    await finished(plain, a.job);
    assert.equal((await plain.jobs.start(page, "other", idle)).state, "reading");
    assert.equal(plain.calls.probe.length, 2);
  });

  it("a refusal while the length is asked is a refusal too: the site is left alone from then on", async () => {
    const s = setup({ cooldownMs: HOURS }, {
      probe: async () => {
        throw new Refused(412);
      },
    });
    assert.deepEqual(await s.jobs.start(page, "other", idle), { state: "unavailable", seconds: null });
    const probed = s.calls.probe.length;
    assert.deepEqual(await s.jobs.start(page, "other", idle), { state: "unavailable", seconds: null });
    assert.equal(s.calls.probe.length, probed, "asked again during the cool-down");
  });

  it("a short link and the site's other addresses are one site: bilibili.com, b23.tv and m.bilibili.com", async () => {
    const s = setup({ cooldownMs: HOURS }, refusing());
    const a = await s.jobs.start({ kind: "page", page: "https://b23.tv/AbCdEf" }, "other", idle);
    assert.ok(a.state === "reading");
    await finished(s, a.job);
    for (const address of [PAGE, "https://m.bilibili.com/video/BV1xx411c7mD", "https://b23.tv/Other"]) {
      assert.equal((await s.jobs.start({ kind: "page", page: address }, "other", idle)).state, "unavailable", address);
    }
    assert.equal(s.calls.probe.length, 1);
  });

  it("a job that was waiting for the site when it refused never downloads: unavailable, and the next site's job runs", async () => {
    const hold = gate();
    let downloads = 0;
    const s = setup({ cooldownMs: HOURS, concurrency: 1 }, {
      download: async (ref, dir) => {
        downloads++;
        if (ref.kind === "page") {
          await hold.opened;
          throw new Refused(567);
        }
        await writeFile(join(dir, "media.mp4"), "video");
        return join(dir, "media.mp4");
      },
    });
    const first = await s.jobs.start(page, "other", idle);
    const waitingSame = await s.jobs.start({ kind: "page", page: "https://www.bilibili.com/video/BV1second0000" }, "other", idle);
    const waitingOther = await s.jobs.start(direct(), "xiaohongshu", idle);
    assert.ok(first.state === "reading" && waitingSame.state === "reading" && waitingOther.state === "reading");
    assert.ok(await until(() => downloads === 1));
    hold.open();
    assert.deepEqual(await finished(s, first.job), { state: "done", video_state: "unavailable" });
    assert.deepEqual(await finished(s, waitingSame.job), { state: "done", video_state: "unavailable" });
    assert.deepEqual((await finished(s, waitingOther.job))?.state, "done");
    assert.equal(downloads, 2, "the waiting job of the same site was downloaded");
    assert.ok(s.logs.some((l) => JSON.parse(l).stage === "cooldown"));
  });

  it("no cool-down when it is not set or 0: a refusal is just an unavailable video", async () => {
    for (const over of [{}, { cooldownMs: 0 }]) {
      const s = setup(over, refusing());
      const a = await s.jobs.start(page, "other", idle);
      assert.ok(a.state === "reading");
      await finished(s, a.job);
      assert.equal((await s.jobs.start(page, "other", idle)).state, "reading");
    }
  });

  it("is kept by the site's name alone: nothing of the address stays, and the log says that it began but not for what", async () => {
    const s = setup({ cooldownMs: HOURS }, refusing());
    const a = await s.jobs.start(page, "other", idle);
    assert.ok(a.state === "reading");
    await finished(s, a.job);
    const kept = JSON.stringify(s.jobs.retained());
    for (const never of ["BV1xx411c7mD", "bilibili"]) assert.ok(!kept.includes(never), never);
    const lines = s.logs.map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.result === "video_cooldown" && l.platform === "other" && l.ms === 0));
    for (const never of ["BV1xx411c7mD", "bilibili", "567"]) assert.ok(!s.logs.join("\n").includes(never), never);
  });
});
