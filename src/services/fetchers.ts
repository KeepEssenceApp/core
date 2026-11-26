// The ways a saved link's content can be read, tried in the operator's order:
//   direct     the core fetches the page itself (always available, free)
//   jina       a reader service (Jina Reader, or a self-hosted one with the same interface)
//   firecrawl  a scraping service (Firecrawl, or a self-hosted one)
// The reader services are off until the operator turns them on in the portal. Turning one on
// means the address of what a user saved is sent to that service.
import { now } from "../clock";
import { num, outbound, type Env } from "../env";
import { truncate } from "../util";
import { fetchPage, isPublicUrl, type Page } from "./fetchpage";
import { THIN_CHARS } from "./pagerules";

export type ProviderId = "direct" | "jina" | "firecrawl";
export const PROVIDERS: ProviderId[] = ["direct", "jina", "firecrawl"];

export interface ProviderSettings {
  enabled: boolean;
  /** Empty: the service's public address. */
  endpoint: string;
  key: string;
}
export interface TestResult {
  at: number;
  url_host: string;
  ok: boolean;
  chars: number;
  ms: number;
  error: string;
}
export interface FetchSettings {
  order: ProviderId[];
  jina: ProviderSettings;
  firecrawl: ProviderSettings;
  tests: Partial<Record<ProviderId, TestResult>>;
}

const KEY = "fetch.settings";
const DEFAULTS: FetchSettings = {
  order: ["direct", "jina", "firecrawl"],
  jina: { enabled: false, endpoint: "", key: "" },
  firecrawl: { enabled: false, endpoint: "", key: "" },
  tests: {},
};
const PUBLIC_ENDPOINT: Record<Exclude<ProviderId, "direct">, string> = { jina: "https://r.jina.ai", firecrawl: "https://api.firecrawl.dev" };
const PROVIDER_TIMEOUT_MS = 20_000;

export async function loadFetchSettings(env: Env): Promise<FetchSettings> {
  const row = await env.DB.prepare("SELECT value FROM core_state WHERE key = ?").bind(KEY).first<{ value: string }>();
  if (!row) return structuredClone(DEFAULTS);
  try {
    const v = JSON.parse(row.value) as Partial<FetchSettings>;
    const order = (Array.isArray(v.order) ? v.order : []).filter((p): p is ProviderId => PROVIDERS.includes(p as ProviderId));
    for (const p of PROVIDERS) if (!order.includes(p)) order.push(p);
    return {
      order,
      jina: { ...DEFAULTS.jina, ...(v.jina ?? {}) },
      firecrawl: { ...DEFAULTS.firecrawl, ...(v.firecrawl ?? {}) },
      tests: v.tests ?? {},
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export async function saveFetchSettings(env: Env, s: FetchSettings): Promise<void> {
  await env.DB.prepare("INSERT INTO core_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(KEY, JSON.stringify(s), now())
    .run();
}

/** An endpoint the operator typed: https only, no credentials in it. Empty is the public one. */
export function validEndpoint(raw: string): boolean {
  if (raw === "") return true;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** What the reader service says about the video of a post (#103). Only the `jina` slot, the runner, ever says it. */
export type VideoEnd = "no_speech" | "too_long" | "unavailable";
export type VideoInfo =
  | { state: "reading"; job: string; seconds: number | null }
  | { state: "too_long" | "unavailable"; seconds: number | null };

/** A page as a way of reading brought it back; `video` only from the runner. */
export interface ReadPage extends Page {
  video?: VideoInfo;
}

/** Real content by length alone: what a reader service brings back, and the author's text of a video post. */
export const longEnough = (text: string): boolean => text.replace(/\s+/g, "").length >= THIN_CHARS;

/**
 * Is this real content? The direct read says so itself (pagerules.ts: walls, page shells, short posts).
 * What a reader service brings back is judged by its length alone. A post whose video is being read
 * is kept, whatever its caption: the words of the video are still to come, and "not fetched" would be
 * wrong while they are.
 */
export const usable = (p: ReadPage): boolean => p.video?.state === "reading" || (p.verdict ? p.verdict.quality === "ok" : longEnough(p.text));

// The reader service's job ids go into a path: letters, digits, dash, underscore only.
const JOB_ID = /^[A-Za-z0-9_-]{1,100}$/;

function parseVideo(raw: unknown): VideoInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as { state?: unknown; job?: unknown; seconds?: unknown };
  const seconds = typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds >= 0 ? Math.round(v.seconds) : null;
  if (v.state === "reading") return typeof v.job === "string" && JOB_ID.test(v.job) ? { state: "reading", job: v.job, seconds } : null;
  if (v.state === "too_long" || v.state === "unavailable") return { state: v.state, seconds };
  return null;
}

function providerBase(s: FetchSettings, id: Exclude<ProviderId, "direct">): string {
  return (s[id].endpoint || PUBLIC_ENDPOINT[id]).replace(/\/+$/, "");
}

function providerAuth(conf: ProviderSettings): Record<string, string> {
  return conf.key ? { authorization: `Bearer ${conf.key}` } : {};
}

async function timed<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await work(abort.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** One provider, once. Throws with a short reason when it cannot read the page. */
export async function runProvider(env: Env, id: ProviderId, s: FetchSettings, url: string): Promise<ReadPage> {
  if (!isPublicUrl(url)) throw new Error("not a public address");
  const maxChars = num(env.BODY_MAX_CHARS, 100000);
  if (id === "direct") {
    const page = await fetchPage(env, url);
    if (!page) throw new Error("no answer that could be read");
    if (page.verdict?.quality === "blocked") throw new Error(`the page refused the read (${page.verdict.reason})`.slice(0, 200));
    return page;
  }
  const conf = s[id];
  const base = providerBase(s, id);
  const auth = providerAuth(conf);
  return timed(PROVIDER_TIMEOUT_MS, async (signal) => {
    if (id === "jina") {
      const res = await outbound(env, `${base}/${url}`, { signal, headers: { accept: "application/json", ...auth } });
      // res.ok holds for 202 too: a video is being read, and the body says which job.
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as { data?: { title?: string; content?: string }; video?: unknown };
      const video = parseVideo(j.video);
      if (res.status === 202 && video?.state !== "reading") throw new Error("the answer named no video job");
      const text = (j.data?.content ?? "").trim();
      // A video post may come without any text of the author's.
      if (!text && !video) throw new Error("the answer held no text");
      return { title: (j.data?.title ?? "").trim(), site: "", text: truncate(text, maxChars), ...(video ? { video } : {}) };
    }
    const res = await outbound(env, `${base}/v1/scrape`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const j = (await res.json()) as { success?: boolean; data?: { markdown?: string; metadata?: { title?: string } } };
    const text = (j.data?.markdown ?? "").trim();
    if (j.success === false || !text) throw new Error("the answer held no text");
    return { title: (j.data?.metadata?.title ?? "").trim(), site: "", text: truncate(text, maxChars) };
  });
}

/** A short fixed list, so the counts never hold an address. */
export function platformOf(url: string): string {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "mp.weixin.qq.com" || host.endsWith(".weixin.qq.com")) return "wechat";
  if (/(^|\.)(xiaohongshu\.com|rednote\.com|xhslink\.com)$/.test(host)) return "xiaohongshu";
  return "other";
}

async function count(env: Env, url: string, path: string): Promise<void> {
  const day = new Date(now()).toISOString().slice(0, 10);
  await env.DB.prepare("INSERT INTO fetch_stats (day, platform, path, n) VALUES (?, ?, ?, 1) ON CONFLICT (day, platform, path) DO UPDATE SET n = n + 1")
    .bind(day, platformOf(url), path)
    .run()
    .catch(() => {});
}

/** How a video ended, as a count: `video` when its words were recognized, `video_failed` when they were not. No address, no account. */
export async function countVideo(env: Env, url: string, recognized: boolean): Promise<void> {
  await count(env, url, recognized ? "video" : "video_failed");
}

export interface Fetched {
  /** The page, or null when no way could read it. `thin`: only a title came back, no content. */
  page: ReadPage | null;
  thin: boolean;
  path: ProviderId | "none";
  /**
   * What the runner said about the post's video, when it said anything: `reading` (a job to ask
   * about), or `too_long` / `unavailable` (the video will not be read).
   */
  video?: VideoInfo;
}

/**
 * The content of a link, by the first way that gets real content. A page that is only a shell
 * does not count; if nothing better comes, its title is kept and the content is "not fetched".
 * A runner that is reading the video of the post ends the search at once: the post is kept as it
 * is, and the words of the video are asked for later. Never throws.
 */
// WeChat and Xiaohongshu links matter most, are the ones the direct read gets least of, and are the ones
// with videos in them (#103). The direct read can find a caption long enough to be content and never ask the
// runner, so the video would never be read: when a reader service is on, those links are asked of it first,
// whatever order the operator chose. Every other link keeps the order.
const READER_FIRST = new Set(["wechat", "xiaohongshu"]);
function orderFor(s: FetchSettings, url: string): ProviderId[] {
  if (!s.jina.enabled || !READER_FIRST.has(platformOf(url))) return s.order;
  return ["jina", ...s.order.filter((p) => p !== "jina")];
}

export async function fetchContent(env: Env, url: string): Promise<Fetched> {
  let s: FetchSettings;
  try {
    s = await loadFetchSettings(env);
  } catch {
    s = structuredClone(DEFAULTS);
  }
  let shell: ReadPage | null = null;
  // A video that will not be read belongs to the link, whichever way reads its text in the end.
  let unread: VideoInfo | undefined;
  for (const id of orderFor(s, url)) {
    if (id !== "direct" && !s[id].enabled) continue;
    try {
      const page = await runProvider(env, id, s, url);
      if (page.video && page.video.state !== "reading") unread ??= page.video;
      if (usable(page)) {
        // A title the page itself gave (direct) is better than none from a reader.
        if (!page.title && shell?.title) page.title = shell.title;
        if (!page.site && shell?.site) page.site = shell.site;
        await count(env, url, id);
        const video = page.video?.state === "reading" ? page.video : unread;
        // Counted when it is known to be over; a video still being read is counted when it ends.
        if (video && video.state !== "reading") await countVideo(env, url, false);
        return { page, thin: false, path: id, ...(video ? { video } : {}) };
      }
      if (!shell && (page.title || page.text)) shell = page;
    } catch {
      /* the next way */
    }
  }
  await count(env, url, "none");
  if (unread) await countVideo(env, url, false);
  const video = unread ? { video: unread } : {};
  return shell ? { page: { ...shell, text: "" }, thin: true, path: "none", ...video } : { page: null, thin: false, path: "none", ...video };
}

// ---------------------------------------------------------------- the runner's jobs (#103)
// `GET {endpoint}/jobs/{id}` asks how a video is coming on, `DELETE` cancels it. Same address and
// key as the `jina` slot: only that slot ever answers 202. A job id is the runner's own opaque
// word; it carries no address and no account.

const JOB_TIMEOUT_MS = 8_000;

export type JobAnswer =
  | { kind: "reading" }
  | { kind: "done"; state: "recognized" | VideoEnd; text: string }
  /** The runner does not know the job (it ended, expired or restarted). */
  | { kind: "gone" }
  /** No answer that says anything: the runner is down, off, or confused. Ask again next minute. */
  | { kind: "silent" };

export async function askVideoJob(env: Env, s: FetchSettings, job: string): Promise<JobAnswer> {
  if (!s.jina.enabled || !JOB_ID.test(job)) return { kind: "silent" };
  try {
    return await timed(JOB_TIMEOUT_MS, async (signal): Promise<JobAnswer> => {
      const res = await outbound(env, `${providerBase(s, "jina")}/jobs/${job}`, { signal, headers: { accept: "application/json", ...providerAuth(s.jina) } });
      if (res.status === 404) return { kind: "gone" };
      if (!res.ok) return { kind: "silent" };
      const j = (await res.json()) as { state?: unknown; video_state?: unknown; recognized_text?: unknown };
      if (j.state === "reading") return { kind: "reading" };
      if (j.state !== "done") return { kind: "silent" };
      if (j.video_state === "recognized") return { kind: "done", state: "recognized", text: typeof j.recognized_text === "string" ? j.recognized_text : "" };
      // A state this core does not know is a video that was not read.
      const state = j.video_state === "no_speech" || j.video_state === "too_long" ? j.video_state : "unavailable";
      return { kind: "done", state, text: "" };
    });
  } catch {
    return { kind: "silent" };
  }
}

/**
 * Tells the runner the job is no longer wanted. Best effort: the runner forgets a job by its own
 * deadline anyway. Asked even when the operator has turned the slot off since: the job exists.
 */
export async function cancelVideoJob(env: Env, s: FetchSettings, job: string): Promise<void> {
  if (!JOB_ID.test(job)) return;
  try {
    await timed(JOB_TIMEOUT_MS, async (signal) => {
      await outbound(env, `${providerBase(s, "jina")}/jobs/${job}`, { method: "DELETE", signal, headers: providerAuth(s.jina) });
    });
  } catch {
    /* best effort */
  }
}

/** The same, for a caller that has no settings at hand. */
export async function cancelJob(env: Env, job: string): Promise<void> {
  try {
    await cancelVideoJob(env, await loadFetchSettings(env), job);
  } catch {
    /* best effort */
  }
}
