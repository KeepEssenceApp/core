// The browser. It does its own networking (so it looks like Chrome to the sites that look), but only
// through proxy.ts, which decides where a connection may go. Here: one fresh context for each visit with
// credentials of its own, pictures / sound / fonts never asked for, and everything closed when the visit
// ends or the time is up.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { hostOf, onDomain, UA_IPHONE } from "../../src/services/pagerules.ts";
import { isPublicUrl } from "../../src/services/publicurl.ts";
import type { Config } from "./config.ts";
import { REFUSED, type FilteringProxy } from "./proxy.ts";

/** What a site's own page data says the post is: the post and nothing around it (no comments, no feed of other posts). */
export interface Post {
  title: string;
  text: string;
}

export interface Rendered {
  /** Set for the sites that have an extractor (Xiaohongshu notes), when the page carries the post. */
  post?: Post;
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
  private proxy: FilteringProxy;
  constructor(cfg: Config, proxy: FilteringProxy) {
    this.cfg = cfg;
    this.proxy = proxy;
  }

  async #get(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    this.#launching ??= chromium
      .launch({
        headless: true,
        executablePath: this.cfg.chromiumPath,
        // Each context names its own proxy (with its own credentials); the loopback is not exempt, so a page
        // that asks for localhost is sent to the proxy too, and refused there.
        proxy: { server: "per-context" },
        args: [
          "--proxy-bypass-list=<-loopback>",
          // Chromium's own Accept-Language, the list of the direct read: zh-CN,zh;q=0.9,en;q=0.8
          "--lang=zh-CN",
          "--accept-lang=zh-CN,zh,en",
          "--webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--force-webrtc-ip-handling-policy",
          "--disable-background-networking",
          "--disable-sync",
          "--no-first-run",
          ...this.cfg.chromiumArgs,
        ],
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
    const read = this.proxy.open(this.cfg.maxBytes);
    const phone = ua === UA_IPHONE;
    let context: BrowserContext | null = null;
    const stop = () => {
      read.close();
      void context?.close().catch(() => {});
    };
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    try {
      context = await browser.newContext({
        userAgent: ua,
        viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: phone,
        hasTouch: phone,
        serviceWorkers: "block",
        acceptDownloads: false,
        proxy: { server: `http://127.0.0.1:${this.proxy.port}`, username: read.username, password: read.password, bypass: "<-loopback>" },
      });
      // Pictures, sound and fonts add nothing to the words, and each is a request to somebody's server. An address
      // that is not public is refused here as well as at the proxy.
      await context.route("**/*", (route) => {
        const req = route.request();
        const type = req.resourceType();
        if (type === "image" || type === "media" || type === "font" || !isPublicUrl(req.url())) return route.abort("blockedbyclient").catch(() => {});
        return route.continue().catch(() => {});
      });
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: this.cfg.deadlineMs });
      if (response?.headers()[REFUSED]) throw new Error("the proxy refused that address");
      const type = (response?.headers()["content-type"] ?? "").toLowerCase();
      if (type && !/html|xml|text\/plain/.test(type)) throw new Error("not a page");
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
      const finalUrl = page.url();
      return { status: response?.status() ?? 0, finalUrl, ...data, post: (await postOf(page, finalUrl)) ?? undefined };
    } finally {
      signal.removeEventListener("abort", stop);
      read.close();
      await context?.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = null;
    await b?.close().catch(() => {});
  }
}

/**
 * A Xiaohongshu note page is the note, its comments, the author's other notes and a feed of unrelated ones, all as
 * text. The page's own data holds the note itself (title, caption, author); that is what is read.
 */
async function postOf(page: Page, url: string): Promise<Post | null> {
  if (!onDomain(hostOf(url), ["xiaohongshu.com", "rednote.com"])) return null;
  return page
    .evaluate(() => {
      const state = (window as unknown as { __INITIAL_STATE__?: { noteData?: { data?: { noteData?: Record<string, any> } } } }).__INITIAL_STATE__;
      const note = state?.noteData?.data?.noteData;
      if (!note || typeof note !== "object") return null;
      // The site writes a topic as `#阳台[话题]#`; the marker is its own, not the author's.
      const clean = (v: unknown) => (typeof v === "string" ? v.replace(/\[话题\]/g, "").replace(/\s+/g, " ").trim() : "");
      const title = clean(note.title);
      const text = [title, clean(note.user?.nickName ?? note.user?.nickname), clean(note.desc)].filter(Boolean).join("\n");
      return text ? { title, text } : null;
    })
    .catch(() => null);
}
