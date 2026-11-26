// The interface of Jina Reader, so the core's System page can point at it as it would at the
// service: GET /<address> with `Accept: application/json` and `Authorization: Bearer <key>`
// answers { data: { title, content } }. Anything the runner cannot read is an error status,
// and the core goes on to the next way (and says "content could not be fetched" if none).
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Config } from "./config.ts";
import { platformOf, readUrl, type ReadResult } from "./read.ts";
import type { Renderer } from "./render.ts";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** `/https://host/path?q` or, when a proxy has merged the slashes, `/https:/host/path?q`. */
export function targetOf(path: string): string | null {
  const m = /^\/(https?):\/{1,2}(.+)$/i.exec(path);
  return m ? `${m[1].toLowerCase()}://${m[2]}` : null;
}

const STATUS: Record<string, number> = { invalid: 400, wall: 422, thin: 422, error: 502, timeout: 504 };

export function createRunner(cfg: Config, renderer: Pick<Renderer, "render">, log: (line: string) => void = (l) => console.log(l)): http.Server {
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
      result = await readUrl(renderer, cfg, url);
    } catch {
      result = { ok: false, kind: "error", message: "the read failed" };
    } finally {
      release();
    }
    // What is logged: that a read happened, how it went and how long it took. Never the address, an account or a word of the page.
    log(JSON.stringify({ at: new Date().toISOString(), result: result.ok ? "ok" : result.kind, platform: platformOf(url), ms: Date.now() - started }));
    if (result.ok) return send(res, 200, { code: 200, status: 20000, data: { title: result.title, url, content: result.content } });
    send(res, STATUS[result.kind] ?? 502, { code: STATUS[result.kind] ?? 502, error: result.kind, message: result.message });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}
