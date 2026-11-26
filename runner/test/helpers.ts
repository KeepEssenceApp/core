// A runner with a real headless browser and a made-up network: every address a page asks for is answered
// from a table of fabricated pages, and written down, so a test can say what was and was not asked for.
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { UA_IPHONE } from "../../src/services/pagerules.ts";
import { loadConfig, type Config } from "../src/config.ts";
import type { NetRequest, NetResponse } from "../src/net.ts";
import { Renderer } from "../src/render.ts";
import { createRunner } from "../src/server.ts";

export const KEY = "test-runner-key-0123456789abcdef";
export interface Hit {
  url: string;
  ua: "desktop" | "iphone";
  type: string;
}
export type Answer = NetResponse | "hang" | Promise<NetResponse>;
export type Routes = Record<string, (r: NetRequest, hit: Hit) => Answer>;

export const reply = (body: string, status = 200, headers: Record<string, string> = {}): NetResponse => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", ...headers },
  body: Buffer.from(body),
});
export const page = (title: string, body: string, head = ""): NetResponse => reply(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`);
export const redirect = (to: string): NetResponse => ({ status: 302, headers: { location: to }, body: Buffer.alloc(0) });

export const TEA = "Steep green tea for two minutes in water of about eighty degrees, and taste it before the second cup, because the leaves give more each time they are steeped.";
export const article = (title = "How to brew tea") => page(title, `<article><h1>${title}</h1><p>${TEA}</p><p>${TEA}</p></article>`);
export const WALL = () => page("Weixin Official Accounts Platform", "<div><p>环境异常</p><p>当前环境异常，完成验证后即可继续访问，请点击下面的按钮，按照页面的提示完成安全验证，验证通过之后页面会自动刷新并回到你要看的内容。</p><p>去验证</p></div>");

export interface Started {
  base: string;
  hits: Hit[];
  logs: string[];
  cfg: Config;
  server: Server;
  renderer: Renderer;
  read: (url: string, key?: string | null) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}

export async function start(routes: Routes, over: Record<string, string> = {}): Promise<Started> {
  const cfg = loadConfig({ RUNNER_KEY: KEY, RUNNER_DEADLINE_MS: "8000", ...over });
  const hits: Hit[] = [];
  const logs: string[] = [];
  const net = async (r: NetRequest): Promise<NetResponse> => {
    const hit: Hit = { url: r.url, ua: (r.headers?.["user-agent"] ?? "") === UA_IPHONE ? "iphone" : "desktop", type: "" };
    hits.push(hit);
    const route = routes[r.url];
    if (!route) return reply("not found", 404);
    const answer = route(r, hit);
    if (answer === "hang") return new Promise((_, reject) => r.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return answer;
  };
  const renderer = new Renderer(cfg, net);
  const server = createRunner(cfg, renderer, (l) => logs.push(l));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    hits,
    logs,
    cfg,
    server,
    renderer,
    async read(url, key = KEY) {
      const res = await fetch(`${base}/${url}`, { headers: { accept: "application/json", ...(key === null ? {} : { authorization: `Bearer ${key}` }) } });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    async close() {
      server.close();
      server.closeAllConnections();
      await renderer.close();
    },
  };
}
