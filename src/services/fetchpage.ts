// Fetching the content of a saved link. Runs after the save was answered.
// Rules: http/https only; never a private, loopback or link-local host, re-checked before every
// attempt and on every redirect (at most 3 per attempt); 8 seconds in total, shared by all the
// attempts; cheap extraction with HTMLRewriter; the stored text is capped.
// The address is asked for with a desktop and then a phone User-Agent (the phone first for some
// apps), and a verification wall makes the next one go (pagerules.ts, QA #100).
import { LIMITS, num, outbound, type Env } from "../env";
import { truncate } from "../util";
import { ACCEPT_LANGUAGE, assessPage, REFUSAL_STATUSES, userAgentsFor, wallHint, type Verdict } from "./pagerules";
import { isPublicUrl } from "./publicurl";

export { isPublicUrl };

export interface Page {
  title: string;
  site: string;
  text: string;
  /** Set by the direct read: what it made of the page. Without it (a reader service) only the length of the text counts. */
  verdict?: Verdict;
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
/** How much of the start of the markup is kept to look for wall words in (bytes). */
const HEAD_BYTES = 60000;

interface Extracted {
  title: string;
  site: string;
  text: string;
  description: string;
  noscript: string;
  head: string;
}

async function extract(response: Response, maxChars: number, abort: AbortController): Promise<Extracted> {
  let title = "";
  let ogTitle = "";
  let site = "";
  let description = "";
  let noscript = "";
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
  // The start of the markup is kept as it passes, for looking for wall words in.
  const headChunks: Uint8Array[] = [];
  let headBytes = 0;
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (headBytes < HEAD_BYTES) {
        headChunks.push(chunk);
        headBytes += chunk.byteLength;
      }
      controller.enqueue(chunk);
    },
  });
  const tapped = new Response(response.body!.pipeThrough(tap), { status: response.status, headers: response.headers });
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
        if ((key === "og:description" || key === "description") && !description) description = content;
      },
    })
    .on("noscript", {
      text(chunk) {
        if (noscript.length < 1000) noscript += chunk.text;
      },
    })
    .on("script, style, noscript, nav, footer, aside, form, svg, template, iframe", skipper)
    .on("p, h1, h2, h3, h4, li, blockquote, pre, td, figcaption", block)
    .transform(tapped);
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
    description: decode(description.replace(/\s+/g, " ").trim()),
    noscript: decode(noscript.replace(/\s+/g, " ").trim()),
    head: new TextDecoder().decode(concat(headChunks)),
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** What one attempt (one User-Agent, the redirects it follows) came to. */
type Attempt =
  | { kind: "page"; page: Page }
  /** A site that refused this client, or a verification wall: the next User-Agent may do better. */
  | { kind: "wall"; reason: string }
  /** Nothing to read, and a different User-Agent would not change it (an error, not a page, a bad redirect). */
  | { kind: "none" };

async function attempt(env: Env, raw: string, ua: string, maxChars: number, deadline: AbortSignal): Promise<Attempt> {
  // One deadline for all the attempts together; this attempt can also stop itself (enough text read).
  const own = new AbortController();
  const follow = () => own.abort();
  if (deadline.aborted) own.abort();
  else deadline.addEventListener("abort", follow, { once: true });
  try {
    let url = raw;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      // Before every request: the address itself and each place a redirect leads to.
      if (!isPublicUrl(url)) return { kind: "none" };
      const response = await outbound(env, url, {
        redirect: "manual",
        signal: own.signal,
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.8", "accept-language": ACCEPT_LANGUAGE, "user-agent": ua },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        await response.body?.cancel().catch(() => {});
        if (!next) return { kind: "none" };
        url = new URL(next, url).toString();
        continue;
      }
      if (REFUSAL_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        return { kind: "wall", reason: `status ${response.status}` };
      }
      if (!response.ok || !response.body) return { kind: "none" };
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      if (type.startsWith("text/plain")) {
        const text = truncate((await response.text()).trim(), maxChars);
        return text ? { kind: "page", page: { title: "", site: "", text } } : { kind: "none" };
      }
      if (type && !type.includes("html")) return { kind: "none" };
      const got = await extract(response, maxChars, own);
      const wall = wallHint(got);
      if (wall) return { kind: "wall", reason: `wall: ${wall}` };
      if (!got.text && !got.title) return { kind: "none" };
      const verdict = assessPage({ url, text: got.text, description: got.description });
      // A short post: its description is the post.
      const text = verdict.caption ? truncate(got.description, maxChars) : got.text;
      return { kind: "page", page: { title: got.title, site: got.site, text, verdict } };
    }
    return { kind: "none" }; // too many redirects
  } finally {
    deadline.removeEventListener("abort", follow);
  }
}

/**
 * Returns the page, or null when the content could not be fetched. Never throws.
 * A page whose every attempt was a wall comes back with the verdict "blocked" and no title and no
 * text: what a wall says is not the page's.
 */
export async function fetchPage(env: Env, raw: string): Promise<Page | null> {
  const timeoutMs = num(env.PAGE_FETCH_TIMEOUT_MS, LIMITS.page_fetch_timeout_seconds * 1000);
  const maxChars = num(env.BODY_MAX_CHARS, 100000);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  let walled: string | null = null;
  const blocked = (): Page | null => (walled ? { title: "", site: "", text: "", verdict: { quality: "blocked", reason: walled } } : null);
  try {
    for (const ua of userAgentsFor(raw)) {
      const got = await attempt(env, raw, ua, maxChars, deadline.signal);
      if (got.kind === "page") return got.page;
      if (got.kind === "none") return blocked();
      walled = got.reason;
    }
    return blocked();
  } catch {
    return blocked();
  } finally {
    clearTimeout(timer);
  }
}
