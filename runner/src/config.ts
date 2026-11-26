// The runner's settings, all from the environment. Nothing here is a secret except RUNNER_KEY.
export interface Config {
  /** Where to listen. The tunnel (cloudflared) connects here; nothing else should. */
  host: string;
  port: number;
  /** The shared secret the core sends as `Authorization: Bearer`. Filled into the portal's System page, never into a repository. */
  key: string;
  /** All the attempts for one address together. The core gives a reader service 20 seconds, so stay under that. */
  deadlineMs: number;
  /** Pages open at once; more wait in the queue, and when the queue is full the answer is 503 at once. */
  concurrency: number;
  queue: number;
  /** The most the page's own files may add up to (bytes either way through the proxy), and the most text returned. */
  maxBytes: number;
  maxChars: number;
  chromiumPath?: string;
  /** Extra Chromium flags (for tests and for a machine that needs --no-sandbox). */
  chromiumArgs: string[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const key = env.RUNNER_KEY ?? "";
  if (key.length < 24) throw new Error("RUNNER_KEY must be set to a secret of at least 24 characters");
  return {
    host: env.RUNNER_HOST || "127.0.0.1",
    port: num(env.RUNNER_PORT, 8820),
    key,
    deadlineMs: num(env.RUNNER_DEADLINE_MS, 17000),
    concurrency: num(env.RUNNER_CONCURRENCY, 2),
    queue: num(env.RUNNER_QUEUE, 4),
    maxBytes: num(env.RUNNER_MAX_BYTES, 8 * 1024 * 1024),
    maxChars: num(env.RUNNER_MAX_CHARS, 100000),
    chromiumPath: env.RUNNER_CHROMIUM_PATH || undefined,
    chromiumArgs: [...(env.RUNNER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []), ...(env.RUNNER_CHROMIUM_ARGS ? env.RUNNER_CHROMIUM_ARGS.split(/\s+/).filter(Boolean) : [])],
  };
}
