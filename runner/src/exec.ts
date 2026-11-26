// Running a program: an argument list, never a shell. What goes wrong here says so in a few fixed words; the
// arguments (they hold an address and the proxy's password) and what the program printed are never put into
// an error, so nothing that is caught and logged can carry them.
import { spawn } from "node:child_process";

export interface RunOptions {
  /** Kills the program (and what it started) when it aborts. */
  signal: AbortSignal;
  timeoutMs: number;
  /** Keep what the program prints on stdout, up to this many bytes (more kills it). Otherwise stdout is thrown away. */
  capture?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * Look in what the program says about its trouble for "HTTP Error <number>" and give that number back as `status`.
   * Nothing else of it is kept: it holds addresses, and it is read and thrown away as it comes.
   */
  watchStatus?: boolean;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  /** The first "HTTP Error <number>" the program said, when `watchStatus` was asked for. */
  status: number | null;
}

/**
 * The environment a program is given: the search path and the language, not this runner's own settings (its key, the
 * transcription worker's) which no program started here has any use for.
 */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

export function run(file: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new Error("aborted"));
    let child;
    try {
      // `detached`: the program gets a process group of its own, so that what it started (yt-dlp starts ffmpeg) is killed with it.
      child = spawn(file, args, { stdio: ["ignore", opts.capture ? "pipe" : "ignore", opts.watchStatus ? "pipe" : "ignore"], env: opts.env ?? childEnv(), detached: true, shell: false, windowsHide: true });
    } catch {
      return reject(new Error("could not start"));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stopped = "";
    let settled = false;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const stop = (why: string) => {
      if (stopped) return;
      stopped = why;
      kill();
    };
    const onAbort = () => stop("aborted");
    const timer = setTimeout(() => stop("timed out"), opts.timeoutMs);
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      fn();
    };
    let status: number | null = null;
    let tail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (status !== null) return;
      const text = tail + chunk.toString("latin1");
      const found = /HTTP Error (\d{3})/.exec(text);
      if (found) status = Number(found[1]);
      tail = text.slice(-24); // enough to join a message cut between two chunks
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (opts.capture ?? 0)) return stop("too much output");
      chunks.push(chunk);
    });
    child.on("error", () => settle(() => reject(new Error("could not start"))));
    child.on("close", (code) => {
      settle(() => (stopped ? reject(new Error(stopped)) : resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), status })));
    });
  });
}
