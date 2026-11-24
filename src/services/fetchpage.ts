// Fetching the content of a saved link. Runs after the save was answered.
// Rules: http/https only; never a private, loopback or link-local host, re-checked on every
// redirect (at most 3); 8 seconds in total; cheap extraction with HTMLRewriter; the stored
// text is capped.
import { LIMITS, num, outbound, type Env } from "../env";
import { truncate } from "../util";

export interface Page {
  title: string;
  site: string;
  text: string;
}

function ipv4Private(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True when the address may be fetched: public http/https only. */
export function isPublicUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  let host = url.hostname.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;
  if (host.startsWith("[")) {
    // IPv6 literal: refuse loopback, unspecified, unique-local, link-local, and mapped IPv4.
    const v6 = host.slice(1, -1);
    if (v6 === "::1" || v6 === "::" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("::ffff:") || v6.startsWith("64:ff9b:")) {
      return false;
    }
    return true;
  }
  if (ipv4Private(host)) return false;
  if (/^\d+$/.test(host) || /^0x/i.test(host)) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  if (/\.(localhost|local|internal|lan|home|corp|intranet|onion)$/.test(host)) return false;
  return true;
}

export function siteOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const MAX_REDIRECTS = 3;
const MAX_BYTES = 2 * 1024 * 1024;

async function extract(response: Response, maxChars: number, abort: AbortController): Promise<Page> {
  let title = "";
  let ogTitle = "";
  let site = "";
  let skip = 0;
  let total = 0;
  const parts: string[] = [];
  let current = "";
  const flush = () => {
    const s = current.replace(/\s+/g, " ").trim();
    current = "";
    if (s && total < maxChars) {
      parts.push(s);
      total += s.length + 1;
    }
  };
  const skipper = {
    element(el: Element) {
      skip++;
      el.onEndTag(() => {
        skip--;
      });
    },
  };
  const block = {
    element(el: Element) {
      flush();
      el.onEndTag(() => flush());
    },
    text(chunk: Text) {
      if (skip === 0 && total < maxChars) current += chunk.text;
    },
  };
  const rewritten = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        if (skip === 0 && title.length < 400) title += chunk.text;
      },
    })
    .on("meta", {
      element(el) {
        const key = el.getAttribute("property") ?? el.getAttribute("name");
        const content = el.getAttribute("content") ?? "";
        if (key === "og:title" && !ogTitle) ogTitle = content;
        if (key === "og:site_name" && !site) site = content;
      },
    })
    .on("script, style, noscript, nav, footer, aside, form, svg, template, iframe", skipper)
    .on("p, h1, h2, h3, h4, li, blockquote, pre, td, figcaption", block)
    .transform(response);
  // Drain the body so the handlers run; stop early once enough was read.
  const reader = rewritten.body!.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES || total >= maxChars) {
      abort.abort();
      break;
    }
  }
  flush();
  const decode = (s: string) =>
    s
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;|&apos;/g, "'")
      .replace(/&nbsp;/g, " ");
  return {
    title: decode((ogTitle || title).replace(/\s+/g, " ").trim()),
    site: decode(site.trim()),
    text: truncate(decode(parts.join("\n")), maxChars),
  };
}

/** Returns the page, or null when the content could not be fetched. Never throws. */
export async function fetchPage(env: Env, raw: string): Promise<Page | null> {
  const timeoutMs = num(env.PAGE_FETCH_TIMEOUT_MS, LIMITS.page_fetch_timeout_seconds * 1000);
  const maxChars = num(env.BODY_MAX_CHARS, 100000);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isPublicUrl(url)) return null;
      const response = await outbound(env, url, {
        redirect: "manual",
        signal: abort.signal,
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "user-agent": "Mozilla/5.0 (compatible; link-reader)" },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!next) return null;
        url = new URL(next, url).toString();
        continue;
      }
      if (!response.ok || !response.body) return null;
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("text/plain")) {
        const text = truncate((await response.text()).trim(), maxChars);
        return text ? { title: "", site: "", text } : null;
      }
      if (type && !type.includes("html")) return null;
      const page = await extract(response, maxChars, abort);
      return page.text || page.title ? page : null;
    }
    return null; // too many redirects
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
