// A runner with a real headless browser and a made-up network. Fabricated pages are served by a local
// server; the proxy's only two test seams are "which addresses does this name have" (every name is a
// public-looking address, or a private one for the names a test says) and "connect to this address" (it
// connects to the local server). The proxy's own rules (public hosts and addresses, ports) all run for real.
import { execFileSync } from "node:child_process";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { createJobs, type Jobs, type JobsOptions } from "../src/jobs.ts";
import type { MediaRef, Pipeline } from "../src/media.ts";
import { FilteringProxy, type Resolved } from "../src/proxy.ts";
import { Renderer } from "../src/render.ts";
import { createRunner } from "../src/server.ts";

export const KEY = "test-runner-key-0123456789abcdef";
export interface Hit {
  /** `http://host/path`, or `https://…` for the TLS server. */
  url: string;
  ua: "desktop" | "iphone";
  lang: string | undefined;
  httpVersion: string;
}
export interface Answer {
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}
/** What a test's handler may do with a response, whether it is HTTP/1 or HTTP/2. */
export interface Res {
  writeHead(status: number, headers?: Record<string, string>): unknown;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly destroyed: boolean;
  readonly writableFinished: boolean;
}
export type Reply = Answer | "hang" | ((res: Res) => void);
export type Routes = Record<string, (hit: Hit) => Reply>;

export const reply = (body: string, status = 200, headers: Record<string, string> = {}): Answer => ({ status, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body });
export const page = (title: string, body: string, head = ""): Answer => reply(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`);
export const redirect = (to: string): Answer => ({ status: 302, headers: { location: to }, body: "" });

export const TEA = "Steep green tea for two minutes in water of about eighty degrees, and taste it before the second cup, because the leaves give more each time they are steeped.";
export const article = (title = "How to brew tea") => page(title, `<article><h1>${title}</h1><p>${TEA}</p><p>${TEA}</p></article>`);
export const WALL = () => page("Weixin Official Accounts Platform", "<div><p>环境异常</p><p>当前环境异常，完成验证后即可继续访问，请点击下面的按钮，按照页面的提示完成安全验证，验证通过之后页面会自动刷新并回到你要看的内容。</p><p>去验证</p></div>");

/** A server that only counts what reaches it: stands for this machine's own network. */
export async function canary(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let n = 0;
  const server = http.createServer((_req, res) => {
    n++;
    res.end("this machine's own network");
  });
  server.on("upgrade", (_req, socket) => {
    n++;
    socket.destroy();
  });
  server.on("connection", () => n++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hits: () => n, close: () => void server.close() };
}

export const SAID = "大家好，今天我们来讲讲怎么泡一壶好茶，水温八十度，泡两分钟。";

/** The media steps, made up: no network, no yt-dlp, no ffmpeg. `calls` says what they were asked. */
export function fakes(over: Partial<Pipeline> = {}): { pipeline: Pipeline; calls: { probe: string[]; download: MediaRef[]; extract: number; transcribe: number } } {
  const calls = { probe: [] as string[], download: [] as MediaRef[], extract: 0, transcribe: 0 };
  const pipeline: Pipeline = {
    probe: async (page) => {
      calls.probe.push(page);
      return 120;
    },
    download: async (ref, dir) => {
      calls.download.push(ref);
      const file = join(dir, "media.mp4");
      await writeFile(file, "video");
      return file;
    },
    extractAudio: async (_file, dir) => {
      calls.extract++;
      const file = join(dir, "audio.ogg");
      await writeFile(file, "audio");
      return file;
    },
    transcribe: async () => {
      calls.transcribe++;
      return { kind: "text", text: SAID };
    },
    ...over,
  };
  return { pipeline, calls };
}

export interface Started {
  base: string;
  hits: Hit[];
  logs: string[];
  cfg: Config;
  server: http.Server;
  proxy: FilteringProxy;
  renderer: Renderer;
  /** The video jobs (their media steps are `fakes`, unless the test gave others) and what those steps were asked. */
  jobs: Jobs;
  jobsRoot: string;
  calls: ReturnType<typeof fakes>["calls"];
  /** A request with the key (or none, or another): `method` and the path after the slash, as the core sends them. */
  call: (method: string, path: string, key?: string | null) => Promise<{ status: number; json: any }>;
  /** Connections to the made-up network that are still open. */
  open: () => number;
  read: (url: string, key?: string | null) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}

export interface Options {
  env?: Record<string, string>;
  /** Names that lead to a private address. */
  privateNames?: string[];
  /** Serve https:// too, with a certificate made for the test (needs openssl). */
  tls?: boolean;
  /** Settings of the video jobs, and the media steps to use in place of the made-up ones. */
  jobs?: Partial<JobsOptions>;
}

export const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

export async function start(routes: Routes, opts: Options = {}): Promise<Started> {
  const cfg = loadConfig({
    RUNNER_KEY: KEY,
    RUNNER_DEADLINE_MS: "8000",
    ...(opts.tls ? { RUNNER_CHROMIUM_ARGS: "--ignore-certificate-errors" } : {}),
    ...(process.env.RUNNER_CHROMIUM_PATH ? { RUNNER_CHROMIUM_PATH: process.env.RUNNER_CHROMIUM_PATH } : {}),
    ...(process.env.RUNNER_NO_SANDBOX ? { RUNNER_NO_SANDBOX: process.env.RUNNER_NO_SANDBOX } : {}),
    ...opts.env,
  });
  const hits: Hit[] = [];
  const logs: string[] = [];
  const sockets = new Set<net.Socket>();
  const track = (s: net.Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  };

  const handle = (scheme: "http" | "https") => (req: http.IncomingMessage | http2.Http2ServerRequest, response: http.ServerResponse | http2.Http2ServerResponse) => {
    const res = response as unknown as Res;
    const host = (req.headers.host ?? req.headers[":authority"] ?? "") as string;
    const url = `${scheme}://${host}${req.url}`;
    const ua = String(req.headers["user-agent"] ?? "").includes("iPhone") ? "iphone" : "desktop";
    const hit: Hit = { url, ua, lang: req.headers["accept-language"] as string | undefined, httpVersion: req.httpVersion };
    hits.push(hit);
    const route = routes[url];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const answer = route(hit);
    if (answer === "hang") return;
    if (typeof answer === "function") return answer(res);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  };

  const plain = http.createServer(handle("http"));
  plain.on("connection", track);
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const plainPort = (plain.address() as AddressInfo).port;

  let tlsServer: http2.Http2SecureServer | null = null;
  let tlsPort = 0;
  let dir = "";
  if (opts.tls) {
    dir = mkdtempSync(join(tmpdir(), "runner-test-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=test", "-days", "1"], { stdio: "ignore" });
    tlsServer = http2.createSecureServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")), allowHTTP1: true }, handle("https") as never);
    tlsServer.on("connection", track);
    await new Promise<void>((resolve) => tlsServer!.listen(0, "127.0.0.1", resolve));
    tlsPort = (tlsServer.address() as AddressInfo).port;
  }

  const privateNames = new Set(opts.privateNames ?? []);
  const lookup = async (host: string): Promise<Resolved[]> => (net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : [{ address: privateNames.has(host) ? "10.0.0.7" : "93.184.216.34", family: 4 }]);
  const proxy = new FilteringProxy({ lookup, connect: (_ip, port) => net.connect({ host: "127.0.0.1", port: port === 443 ? tlsPort : plainPort }) });
  await proxy.listen();
  const renderer = new Renderer(cfg, proxy);
  const jobsRoot = mkdtempSync(join(tmpdir(), "runner-jobs-"));
  const fk = fakes();
  const jobs = createJobs({
    ...fk.pipeline,
    enabled: true,
    maxSeconds: cfg.videoMaxMinutes * 60,
    concurrency: cfg.videoConcurrency,
    queue: cfg.videoQueue,
    root: join(jobsRoot, "jobs"),
    log: (l) => logs.push(l),
    ...opts.jobs,
  });
  await jobs.ready;
  const server = createRunner(cfg, renderer, (l) => logs.push(l), jobs);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, key: string | null = KEY) => {
    const res = await fetch(`${base}/${path}`, { method, headers: { accept: "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }) } });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return {
    base,
    hits,
    logs,
    cfg,
    server,
    proxy,
    renderer,
    jobs,
    jobsRoot: join(jobsRoot, "jobs"),
    calls: fk.calls,
    call,
    open: () => sockets.size,
    read: (url, key = KEY) => call("GET", url, key),
    async close() {
      server.close();
      server.closeAllConnections();
      await jobs.close();
      rmSync(jobsRoot, { recursive: true, force: true });
      await renderer.close();
      await proxy.close();
      for (const s of sockets) s.destroy();
      plain.close();
      tlsServer?.close();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}
