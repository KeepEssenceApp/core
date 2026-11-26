// The browser. It renders; it does not go to the network. Every request it makes is answered here,
// from net.ts (public addresses only, checked at connect time), so the page's own scripts cannot
// reach this machine's network, and Chromium is pointed at a proxy that does not exist so anything
// that slips past the interception (a WebSocket, say) fails instead of connecting.
import { chromium, type Browser, type BrowserContext, type Route } from "playwright-core";
import { ACCEPT_LANGUAGE, UA_IPHONE } from "../../src/services/pagerules.ts";
import { isPublicUrl } from "../../src/services/publicurl.ts";
import type { Config } from "./config.ts";
import { followRedirects, request, type Net, type NetResponse } from "./net.ts";

export interface Rendered {
  status: number;
  finalUrl: string;
  title: string;
  site: string;
  description: string;
  text: string;
  noscript: string;
  head: string;
}

export class Renderer {
  #browser: Browser | null = null;
  #launching: Promise<Browser> | null = null;
  private cfg: Config;
  private net: Net;
  constructor(cfg: Config, net: Net = request) {
    this.cfg = cfg;
    this.net = net;
  }

  async #get(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launching ??= chromium
      .launch({
        headless: true,
        executablePath: this.cfg.chromiumPath,
        args: ["--proxy-server=http://127.0.0.1:1", "--proxy-bypass-list=<-loopback>", "--disable-background-networking", "--disable-sync", "--no-first-run", ...this.cfg.chromiumArgs],
      })
      .then((b) => {
        this.#browser = b;
        b.on("disconnected", () => {
          if (this.#browser === b) this.#browser = null;
        });
        return b;
      })
      .finally(() => {
        this.#launching = null;
      });
    return this.#launching;
  }

  /** One visit in a fresh context: closed when it ends, or at once when `signal` aborts (a read that ran out of time leaves nothing running). */
  async render(url: string, ua: string, signal: AbortSignal): Promise<Rendered> {
    const browser = await this.#get();
    const phone = ua === UA_IPHONE;
    const context: BrowserContext = await browser.newContext({
      userAgent: ua,
      viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
      isMobile: phone,
      hasTouch: phone,
      locale: "zh-CN",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const stop = () => void context.close().catch(() => {});
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    const budget = { left: this.cfg.maxBytes };
    try {
      // The page itself first, with its redirects followed here (each place checked before it is asked): the
      // browser is then sent to where they ended, and is handed the answer already fetched.
      const first = await followRedirects(this.net, {
        url,
        headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5", "accept-language": ACCEPT_LANGUAGE },
        signal,
        maxBytes: budget.left,
      });
      budget.left -= first.body.length;
      const type = (first.headers["content-type"] ?? "").toLowerCase();
      if (type && !/html|xml|text\/plain/.test(type)) throw new Error("not a page");
      const landed = new URL(first.url);
      landed.hash = "";
      const fetched = new Map<string, NetResponse>([[landed.toString(), first]]);
      await context.route("**/*", (route) => this.#answer(route, signal, budget, fetched));
      const page = await context.newPage();
      const response = await page.goto(first.url, { waitUntil: "domcontentloaded", timeout: this.cfg.deadlineMs });
      // Give scripts a moment to draw the page, but not for ever.
      await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
      const data = await page.evaluate(() => {
        const clean = (s: string) => s.replace(/\s+/g, " ").trim();
        const meta = (k: string) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute("content") ?? "";
        let best: HTMLElement | null = null;
        let bestLen = 0;
        for (const c of document.querySelectorAll<HTMLElement>("article, main, [role=main], #js_content, .rich_media_content")) {
          const n = c.innerText?.length ?? 0;
          if (n > bestLen) {
            best = c;
            bestLen = n;
          }
        }
        const container = best && bestLen >= 200 ? best : document.body;
        const lines = (container?.innerText ?? "").split("\n").map(clean).filter(Boolean);
        return {
          title: clean(meta("og:title") || document.title),
          site: clean(meta("og:site_name")),
          description: clean(meta("og:description") || meta("description")),
          text: lines.join("\n"),
          noscript: clean([...document.querySelectorAll("noscript")].map((n) => n.textContent ?? "").join(" ")),
          head: document.documentElement.outerHTML.slice(0, 60000),
        };
      });
      return { status: response?.status() ?? 0, finalUrl: page.url(), ...data };
    } finally {
      signal.removeEventListener("abort", stop);
      await context.close().catch(() => {});
    }
  }

  async #answer(route: Route, signal: AbortSignal, budget: { left: number }, fetched: Map<string, NetResponse>): Promise<void> {
    const req = route.request();
    const type = req.resourceType();
    const ready = fetched.get(req.url());
    if (ready && req.isNavigationRequest()) {
      fetched.delete(req.url());
      await route.fulfill({ status: ready.status, headers: ready.headers, body: ready.body });
      return;
    }
    // Pictures, sound and fonts add nothing to the words, and each is a request to somebody's server.
    if (type === "image" || type === "media" || type === "font" || !isPublicUrl(req.url()) || budget.left <= 0) {
      await route.abort("blockedbyclient").catch(() => {});
      return;
    }
    try {
      const res = await followRedirects(this.net, { url: req.url(), method: req.method(), headers: req.headers(), body: req.postDataBuffer(), signal, maxBytes: budget.left });
      budget.left -= res.body.length;
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
    } catch {
      await route.abort("failed").catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = null;
    await b?.close().catch(() => {});
  }
}
