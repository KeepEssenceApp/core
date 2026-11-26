// The interface of Jina Reader, so the core's System page can point at it as it would at the
// service: GET /<address> with `Accept: application/json` and `Authorization: Bearer <key>`
// answers { data: { title, content } }. Anything the runner cannot read is an error status,
// and the core goes on to the next way (and says "content could not be fetched" if none).
//
// Added for a video post (what is said in the video is read in the background):
//   202 { code, status, data, video: { state: "reading", job, seconds } }   the page's words, and a job to ask about
//   200 { ..., video: { state: "too_long" | "unavailable", seconds } }      the page's words, and why the video is not read
//   GET /jobs/<id>     { state: "reading" } | { state: "done", video_state, recognized_text? } | 404 { error: "unknown" }
//   DELETE /jobs/<id>  204 always: stops the job, removes its files, forgets its result
// A page that is not a video post is answered as before, with no `video` field.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Config } from "./config.ts";
import type { Jobs } from "./jobs.ts";
import { platformOf, readUrl, type ReadResult, type ResolveVideo } from "./read.ts";
import type { Renderer } from "./render.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** `/https://host/path?q` or, when a proxy has merged the slashes, `/https:/host/path?q`. */
export function targetOf(path: string): string | null {
  const m = /^\/(https?):\/{1,2}(.+)$/i.exec(path);
  return m ? `${m[1].toLowerCase()}://${m[2]}` : null;
}

const STATUS: Record<string, number> = { invalid: 400, wall: 422, thin: 422, error: 502, timeout: 504 };

export function createRunner(cfg: Config, renderer: Pick<Renderer, "render">, log: (line: string) => void = (l) => console.log(l), jobs?: Jobs): http.Server {
  // Without jobs (nothing set up to read a video) a video post is "unavailable": its words are still returned.
  const resolveVideo: ResolveVideo = (ref, platform, signal) => (jobs ? jobs.start(ref, platform, signal) : Promise.resolve({ state: "unavailable", seconds: null }));
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = (): Promise<boolean> => {
    if (active < cfg.concurrency) {
      active++;
      return Promise.resolve(true);
    }
    if (waiting.length >= cfg.queue) return Promise.resolve(false);
    return new Promise((resolve) => waiting.push(() => resolve(true)));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? "/";
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!timingSafeEqual(digest(given), digest(cfg.key))) return send(res, 401, { code: 401, error: "unauthorized" });
    // Whatever follows /jobs/ is the id; one that is not the shape of an id is simply not known.
    const jobId = /^\/jobs\/([^?#]*)(?:[?#].*)?$/.exec(path)?.[1];
    if (jobId !== undefined) {
      if (req.method === "GET") {
        const view = jobs?.get(jobId) ?? null;
        return view ? send(res, 200, view) : send(res, 404, { error: "unknown" });
      }
      if (req.method === "DELETE") {
        await jobs?.cancel(jobId);
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      return send(res, 405, { code: 405, error: "method" });
    }
    if (req.method !== "GET") return send(res, 405, { code: 405, error: "method" });
    const url = targetOf(path);
    if (!url) return send(res, 400, { code: 400, error: "invalid", message: "give an address after the slash" });

    const started = Date.now();
    if (!(await acquire())) {
      log(JSON.stringify({ at: new Date().toISOString(), result: "busy", platform: platformOf(url), ms: 0 }));
      return send(res, 503, { code: 503, error: "busy", message: "too many reads at once" });
    }
    let result: ReadResult;
    try {
      result = await readUrl(renderer, cfg, url, resolveVideo);
    } catch {
      result = { ok: false, kind: "error", message: "the read failed" };
    } finally {
      release();
    }
    // What is logged: that a read happened, how it went and how long it took (and for a video post, what became of the video). Never the address, an account, a job or a word of the page.
    log(JSON.stringify({ at: new Date().toISOString(), result: result.ok ? "ok" : result.kind, ...(result.ok && result.video ? { video: result.video.state } : {}), platform: platformOf(url), ms: Date.now() - started }));
    if (!result.ok) return send(res, STATUS[result.kind] ?? 502, { code: STATUS[result.kind] ?? 502, error: result.kind, message: result.message });
    const data = { title: result.title, url, content: result.content };
    const video = result.video;
    if (!video) return send(res, 200, { code: 200, status: 20000, data });
    if (video.state !== "reading") return send(res, 200, { code: 200, status: 20000, data, video: { state: video.state, seconds: video.seconds } });
    // The caller went away while the page was read: a job nobody can ask about is not kept.
    if (res.destroyed || res.socket?.destroyed) {
      void jobs?.cancel(video.job);
      return;
    }
    send(res, 202, { code: 202, status: 20200, data, video: { state: "reading", job: video.job, seconds: video.seconds } });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
