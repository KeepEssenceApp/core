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

/**
 * Is this real content? The direct read says so itself (pagerules.ts: walls, page shells, short posts).
 * What a reader service brings back is judged by its length alone.
 */
export const usable = (p: Page): boolean => (p.verdict ? p.verdict.quality === "ok" : p.text.replace(/\s+/g, "").length >= THIN_CHARS);

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
export async function runProvider(env: Env, id: ProviderId, s: FetchSettings, url: string): Promise<Page> {
  if (!isPublicUrl(url)) throw new Error("not a public address");
  const maxChars = num(env.BODY_MAX_CHARS, 100000);
  if (id === "direct") {
    const page = await fetchPage(env, url);
    if (!page) throw new Error("no answer that could be read");
    if (page.verdict?.quality === "blocked") throw new Error(`the page refused the read (${page.verdict.reason})`.slice(0, 200));
    return page;
  }
  const conf = s[id];
  const base = (conf.endpoint || PUBLIC_ENDPOINT[id]).replace(/\/+$/, "");
  const auth: Record<string, string> = conf.key ? { authorization: `Bearer ${conf.key}` } : {};
  return timed(PROVIDER_TIMEOUT_MS, async (signal) => {
    if (id === "jina") {
      const res = await outbound(env, `${base}/${url}`, { signal, headers: { accept: "application/json", ...auth } });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const j = (await res.json()) as { data?: { title?: string; content?: string } };
      const text = (j.data?.content ?? "").trim();
      if (!text) throw new Error("the answer held no text");
      return { title: (j.data?.title ?? "").trim(), site: "", text: truncate(text, maxChars) };
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

export interface Fetched {
  /** The page, or null when no way could read it. `thin`: only a title came back, no content. */
  page: Page | null;
  thin: boolean;
  path: ProviderId | "none";
}

/**
 * The content of a link, by the first way that gets real content. A page that is only a shell
 * does not count; if nothing better comes, its title is kept and the content is "not fetched".
 * Never throws.
 */
export async function fetchContent(env: Env, url: string): Promise<Fetched> {
  let s: FetchSettings;
  try {
    s = await loadFetchSettings(env);
  } catch {
    s = structuredClone(DEFAULTS);
  }
  let shell: Page | null = null;
  for (const id of s.order) {
    if (id !== "direct" && !s[id].enabled) continue;
    try {
      const page = await runProvider(env, id, s, url);
      if (usable(page)) {
        // A title the page itself gave (direct) is better than none from a reader.
        if (!page.title && shell?.title) page.title = shell.title;
        if (!page.site && shell?.site) page.site = shell.site;
        await count(env, url, id);
        return { page, thin: false, path: id };
      }
      if (!shell && (page.title || page.text)) shell = page;
    } catch {
      /* the next way */
    }
  }
  await count(env, url, "none");
  return shell ? { page: { ...shell, text: "" }, thin: true, path: "none" } : { page: null, thin: false, path: "none" };
}
