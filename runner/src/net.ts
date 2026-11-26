// The only way anything leaves the machine: one request, to a public address, checked at the moment of
// connecting. The browser never makes a request of its own (see render.ts); it asks for this.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { isPublicIp, isPublicUrl } from "../../src/services/publicurl.ts";

export interface NetResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export interface NetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | null;
  signal: AbortSignal;
  maxBytes: number;
}

/**
 * A lookup that refuses any answer holding a non-public address. It runs for the address the socket is
 * about to use, so a name that points into this machine's network, or whose answer changes between a
 * check and the connection, cannot get through. (An IP written into the address does no lookup: net.ts
 * checks those itself.)
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as dns.LookupAddress[];
    if (list.length === 0 || list.some((a) => !isPublicIp(a.address))) {
      const e: NodeJS.ErrnoException = new Error("the name leads to a non-public address");
      e.code = "EBLOCKED";
      return callback(e, "", 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const HOP_BY_HOP = new Set(["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "proxy-authorization", "te", "trailer"]);

export function request(r: NetRequest): Promise<NetResponse> {
  return new Promise((resolve, reject) => {
    if (!isPublicUrl(r.url)) return reject(new Error("not a public address"));
    const url = new URL(r.url);
    const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (net.isIP(host) && !isPublicIp(host)) return reject(new Error("not a public address"));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
    if (r.body && r.body.length) headers["content-length"] = String(r.body.length);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: r.method ?? "GET", headers, lookup: guardedLookup as never, signal: r.signal, timeout: 12000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > r.maxBytes) {
          req.destroy(new Error("the answer is too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        const out: Record<string, string> = {};
        // No cookies are kept: a read is one visit with nothing before it and nothing after.
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !HOP_BY_HOP.has(k) && k !== "set-cookie") out[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 502, headers: out, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("no answer in time")));
    req.on("error", reject);
    if (r.body && r.body.length) req.write(r.body);
    req.end();
  });
}

export type Net = (r: NetRequest) => Promise<NetResponse>;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * One request and the redirects it leads to, followed here and not by the browser: each place a redirect
 * leads to is checked (public, http or https) before anything is asked of it, and at most `hops` are followed.
 * Returns the last answer and the address it came from.
 */
export async function followRedirects(send: Net, r: NetRequest, hops = 5): Promise<NetResponse & { url: string }> {
  let current = { ...r };
  for (let i = 0; i <= hops; i++) {
    if (!isPublicUrl(current.url)) throw new Error("not a public address");
    const res = await send(current);
    const location = res.headers.location;
    if (!REDIRECTS.has(res.status) || !location) return { ...res, url: current.url };
    const next = new URL(location, current.url).toString();
    const keepsMethod = res.status === 307 || res.status === 308 || current.method === undefined || current.method === "GET" || current.method === "HEAD";
    current = { ...current, url: next, method: keepsMethod ? current.method : "GET", body: keepsMethod ? current.body : null };
  }
  throw new Error("too many redirects");
}
