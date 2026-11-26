// The video jobs: what is said in a video post, read in the background. The page read answers at once ("reading",
// with an opaque job id) and the core asks for the result from time to time (GET /jobs/<id>).
//
//   - In memory. A runner that restarts forgets its jobs, and the core's question is then a 404.
//   - One at a time by default, a few waiting. When both are full a new video is "unavailable" at once.
//   - Each job has a directory of its own, which is removed in a `finally`, whatever happened: the video, the sound,
//     a failure, a cancel, the deadline. What an earlier run left behind is removed at start-up.
//   - A job that is over keeps only its result (`video_state` and the words) for 30 minutes, for the core to fetch,
//     and not the address it was made from.
//   - Nothing here is logged but how it went: when, which platform class, how long, never an address or a word.
//
// The steps (length, download, sound, transcription) are parameters. The runner gives it the real ones (media.ts);
// the tests give it their own.
import { randomBytes } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoRef } from "./detect.ts";
import type { MediaRef, Pipeline } from "./media.ts";

export type VideoState = "recognized" | "no_speech" | "too_long" | "unavailable";

/** What the page read says about the video: being read, or why it is not. `seconds` is the length when it is known. */
export type VideoAnswer = { state: "reading"; job: string; seconds: number } | { state: "too_long" | "unavailable"; seconds: number | null };

export type JobView = { state: "reading" } | { state: "done"; video_state: VideoState; recognized_text?: string };

export interface JobsOptions extends Pipeline {
  /** False when no transcription worker is set: every video is then "unavailable". */
  enabled: boolean;
  /** Longer than this is "too long", and is not downloaded. */
  maxSeconds: number;
  concurrency: number;
  /** Waiting places. */
  queue: number;
  /** Where the jobs' directories go. Everything in it is removed at start-up. */
  root?: string;
  /** All the steps of one job together, from the moment it starts to run. */
  deadlineMs?: number;
  /** How long a finished job's result is kept. */
  resultTtlMs?: number;
  /** The clock (a test sets its own). */
  now?: () => number;
  log?: (line: string) => void;
}

export interface Jobs {
  /** The start-up clean-up is done. */
  ready: Promise<void>;
  start(ref: VideoRef, platform: string, signal: AbortSignal): Promise<VideoAnswer>;
  /** null: not known (never made, cancelled, forgotten, or the runner restarted). */
  get(id: string): JobView | null;
  /** Stops a job that is running or waiting, removes its files, and forgets a result. */
  cancel(id: string): Promise<void>;
  /** Stops everything (the runner is stopping). */
  close(): Promise<void>;
  /** Everything held for each job, as plain data: a test looks that no address is among it. */
  retained(): unknown[];
}

interface Job {
  id: string;
  platform: string;
  state: "queued" | "running" | "done";
  /** Where the video is. Dropped when the job is over. */
  ref: MediaRef | null;
  ctl: AbortController;
  result: { video_state: VideoState; recognized_text?: string } | null;
  doneAt: number;
  cancelled: boolean;
  settled: Promise<void>;
}

/** What a job id looks like: the id is checked against it before it is looked up, and a directory is only made for an id made here. */
export const JOB_ID = /^[0-9a-f]{24,64}$/;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });

export function createJobs(opts: JobsOptions): Jobs {
  const root = opts.root ?? join(tmpdir(), "ke-runner-jobs");
  const deadlineMs = opts.deadlineMs ?? 20 * 60 * 1000;
  const ttl = opts.resultTtlMs ?? 30 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((l: string) => console.log(l));
  const say = (fields: Record<string, unknown>) => log(JSON.stringify({ at: new Date().toISOString(), ...fields }));

  const jobs = new Map<string, Job>();
  const waiting: Job[] = [];
  let running = 0;
  let closed = false;

  // Whatever an earlier run left: its jobs are gone with it, and so are their files.
  const ready = (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const name of await readdir(root)) await rm(join(root, name), { recursive: true, force: true });
  })().catch(() => {});

  const sweep = () => {
    for (const [id, job] of jobs) if (job.state === "done" && now() - job.doneAt >= ttl) jobs.delete(id);
  };
  const sweeper = setInterval(sweep, 60 * 1000);
  sweeper.unref();

  async function execute(job: Job): Promise<void> {
    const started = now();
    const dir = join(root, job.id);
    const signal = job.ctl.signal;
    const timer = setTimeout(() => job.ctl.abort("deadline"), deadlineMs);
    let stage = "download";
    let result: NonNullable<Job["result"]> = { video_state: "unavailable" };
    // An abort ends the job at once, even when a step does not look at the signal: the job does not wait for it.
    const step = <T>(work: Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (signal.aborted) return reject(new Error("aborted"));
        const onAbort = () => reject(new Error("aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      });
    try {
      await step(mkdir(dir, { recursive: true, mode: 0o700 }));
      const file = await step(opts.download(job.ref!, dir, signal));
      stage = "extract";
      const audio = await step(opts.extractAudio(file, dir, signal));
      await rm(file, { force: true }); // the video is not needed while the words are waited for
      stage = "transcribe";
      const said = await step(opts.transcribe(audio, signal));
      result = said.kind === "text" ? { video_state: "recognized", recognized_text: said.text } : { video_state: said.kind };
      stage = "done";
    } catch {
      // "unavailable", at `stage` (or a cancel, which has already forgotten the job)
    } finally {
      clearTimeout(timer);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      job.ref = null; // nothing keeps the address
    }
    if (job.cancelled) return;
    if (signal.reason === "deadline" && stage !== "done") stage = "deadline";
    job.state = "done";
    job.result = result;
    job.doneAt = now();
    say({ result: "video_done", video_state: result.video_state, ...(stage === "done" ? {} : { stage }), platform: job.platform, ms: now() - started });
  }

  function pump(): void {
    while (!closed && running < opts.concurrency && waiting.length) {
      const job = waiting.shift()!;
      job.state = "running";
      running++;
      job.settled = execute(job)
        .catch(() => {})
        .finally(() => {
          running--;
          pump();
        });
    }
  }

  return {
    ready,

    async start(ref, platform, signal) {
      await ready;
      const known = ref.kind === "direct" ? ref.seconds : null;
      if (!opts.enabled || closed || ref.kind === "unsupported") return { state: "unavailable", seconds: ref.kind === "unsupported" ? null : known };
      let seconds = known;
      if (ref.kind === "page") {
        try {
          seconds = await opts.probe(ref.page, signal);
        } catch {
          seconds = null;
        }
      }
      // The length is asked before anything is downloaded: a video that is too long is never fetched.
      if (seconds === null) return { state: "unavailable", seconds: null };
      if (seconds > opts.maxSeconds) return { state: "too_long", seconds };
      if (ref.kind === "direct" && ref.urls.length === 0) return { state: "unavailable", seconds };
      if (running + waiting.length >= opts.concurrency + opts.queue) return { state: "unavailable", seconds };
      const id = randomBytes(16).toString("hex");
      const job: Job = { id, platform, state: "queued", ref, ctl: new AbortController(), result: null, doneAt: 0, cancelled: false, settled: Promise.resolve() };
      jobs.set(id, job);
      waiting.push(job);
      pump();
      return { state: "reading", job: id, seconds };
    },

    get(id) {
      const job = JOB_ID.test(id) ? jobs.get(id) : undefined;
      if (!job) return null;
      if (job.state !== "done") return { state: "reading" };
      if (now() - job.doneAt >= ttl) {
        jobs.delete(id);
        return null;
      }
      return { state: "done", ...job.result! };
    },

    async cancel(id) {
      const job = JOB_ID.test(id) ? jobs.get(id) : undefined;
      if (!job) return;
      jobs.delete(id);
      if (job.state === "done") return;
      job.cancelled = true;
      job.ref = null;
      const wasRunning = job.state === "running";
      if (!wasRunning) waiting.splice(waiting.indexOf(job), 1);
      job.ctl.abort("cancelled");
      if (wasRunning) {
        // Its steps stop (the download and the program are killed, the worker's call is dropped) and the directory goes; wait for that, but not for ever.
        await Promise.race([job.settled, sleep(5000)]);
        await rm(join(root, job.id), { recursive: true, force: true }).catch(() => {});
      }
      say({ result: "video_cancelled", platform: job.platform, ms: 0 });
    },

    async close() {
      closed = true;
      clearInterval(sweeper);
      const live = [...jobs.values()].filter((j) => j.state !== "done");
      waiting.length = 0;
      for (const job of live) {
        job.cancelled = true;
        job.ctl.abort("cancelled");
      }
      await Promise.race([Promise.all(live.map((j) => j.settled)), sleep(5000)]);
      jobs.clear();
      await rm(root, { recursive: true, force: true }).catch(() => {});
    },

    retained() {
      return [...jobs.values()].map((j) => ({ id: j.id, state: j.state, platform: j.platform, ref: j.ref, result: j.result }));
    },
  };
}
