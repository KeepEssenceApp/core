// Items: saving helpers, the views the reading clients get, counts, and the page fetch result.
import { CONTRACT } from "../generated/contract";
import { DAY, now } from "../clock";
import { LIMITS, num, type Env } from "../env";
import type { Lang } from "../errors";
import { localDay } from "../time";
import type { AssistantRow, ItemRow, UserRow } from "../types";
import { firstSentence, iso, looksLikeUrl, parseJson, shorten, truncate } from "../util";
import { assetText, isTextType, type AssetRow } from "./assets";
import { fetchPage, siteOf } from "./fetchpage";

export const OPENING_CHARS = 500;

export function sharedText(key: string, lang: Lang): string {
  const node = key.split(".").reduce((o: any, k) => o?.[k], CONTRACT.sharedRules);
  return node?.[lang] ?? "";
}

/** A stable key for "the same address": no fragment, no tracking parameters, no trailing slash. */
export function urlKey(raw: string): string {
  const url = new URL(raw);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid$|gclid$|mc_eid$|mc_cid$|spm$)/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  const query = url.searchParams.toString();
  return `${url.protocol}//${url.host.toLowerCase()}${path}${query ? "?" + query : ""}`;
}

/** A client-given title is used unless it is empty or just an address. */
export function cleanTitle(title: string | undefined): string {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  return t && !looksLikeUrl(t) ? shorten(t, 300) : "";
}

export function countStatement(
  env: Env,
  user: UserRow,
  column: "saved" | "analysed" | "digests" | "notes",
  source = "",
  at = now(),
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO daily_counts (user_id, day, source, ${column}) VALUES (?, ?, ?, 1)
     ON CONFLICT (user_id, day, source) DO UPDATE SET ${column} = ${column} + 1`,
  ).bind(user.id, localDay(at, user.timezone), source);
}

export interface ItemJoined extends ItemRow {
  a_unavailable: number | null;
  a_summary: string | null;
  a_key_fact: string | null;
  a_points: string | null;
  a_verdict: string | null;
  a_related_hint: string | null;
  a_assistant_id: string | null;
  a_created_at: number | null;
  q_item_id: string | null;
}

export const ITEM_SELECT = `
  i.id, i.user_id, i.kind, i.url, i.title, i.site, i.opening, i.asset_id, i.source, i.content_unavailable,
  i.fetch_state, i.pinned, i.expiry_days, i.expires_at, i.hard_expires_at, i.queue_holds, i.dispatch_to,
  i.triaged_at, i.analysed_at, i.digest_day, i.signal, i.created_at,
  a.unavailable AS a_unavailable, a.summary AS a_summary, a.key_fact AS a_key_fact, a.points AS a_points,
  a.verdict AS a_verdict, a.related_hint AS a_related_hint, a.assistant_id AS a_assistant_id, a.created_at AS a_created_at,
  q.item_id AS q_item_id`;

export const ITEM_FROM = `
  FROM items i
  LEFT JOIN analyses a ON a.item_id = i.id AND a.user_id = i.user_id
  LEFT JOIN deep_read_queue q ON q.item_id = i.id AND q.user_id = i.user_id`;

export type Names = Map<string, string>;

export function namesOf(assistants: AssistantRow[]): Names {
  return new Map(assistants.map((a) => [a.id, a.name]));
}

export function signature(names: Names, id: string | null, submittedByUser = false) {
  return { id: id ?? "", name: (id && names.get(id)) || "", ...(submittedByUser ? { submitted_by_user: true } : {}) };
}

export function displayTitle(row: { title: string; content_unavailable: number; kind: string }, lang: Lang): string {
  if (row.title) return row.title;
  if (row.content_unavailable) return sharedText("content_unavailable", lang);
  const label: Record<string, Record<Lang, string>> = {
    link: { zh: "网页", en: "Web page" },
    text: { zh: "文字", en: "Text" },
    image: { zh: "图片", en: "Image" },
    file: { zh: "文件", en: "File" },
  };
  return label[row.kind]?.[lang] ?? "";
}

/** The moment the item is deleted as things stand now; null when it is kept without expiry. */
export function endsAt(row: Pick<ItemRow, "pinned" | "expires_at" | "hard_expires_at" | "queue_holds">, t = now()): number | null {
  if (row.pinned) return null;
  const soft = row.queue_holds > 0 ? Math.max(row.expires_at, t) : row.expires_at;
  return Math.min(soft, row.hard_expires_at);
}

/**
 * Days until the item goes, counted on the calendar in the user's time zone: the days between
 * today's date and the date it ends on. Saved today for 7 days reads 7; tomorrow it reads 6,
 * whatever the hour (QA #83). 0 means it ends today. Without a time zone: whole days, rounded up.
 */
export function daysLeft(row: Pick<ItemRow, "pinned" | "expires_at" | "hard_expires_at" | "queue_holds">, t = now(), tz?: string): number | null {
  const end = endsAt(row, t);
  if (end === null) return null;
  if (end <= t) return 0;
  if (!tz) return Math.ceil((end - t) / DAY);
  const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
  return Math.max(0, Math.round((utc(localDay(end, tz)) - utc(localDay(t, tz))) / DAY));
}

export function analysisView(row: ItemJoined, names: Names, lang: Lang) {
  if (row.a_assistant_id === null) return null;
  const base = { assistant: signature(names, row.a_assistant_id), created_at: iso(row.a_created_at) };
  if (row.a_unavailable) {
    return { unavailable: true, summary: row.a_summary || sharedText("content_unavailable", lang), ...base };
  }
  const fact = row.a_key_fact ?? "";
  return {
    unavailable: false,
    summary: row.a_summary ?? "",
    key_fact: fact,
    points: parseJson<string[]>(row.a_points, []),
    verdict: row.a_verdict,
    related_hint: row.a_related_hint,
    ...base,
  };
}

export function itemView(row: ItemJoined, names: Names, lang: Lang, tz?: string) {
  return {
    id: row.id,
    kind: row.kind,
    title: displayTitle(row, lang),
    site: row.site,
    url: row.url,
    created_at: iso(row.created_at),
    stage: row.analysed_at ? "analysed" : row.triaged_at ? "triaged" : "saved",
    content_unavailable: row.content_unavailable === 1,
    dispatch_to: row.dispatch_to ? { id: row.dispatch_to, name: names.get(row.dispatch_to) ?? "" } : null,
    days_left: daysLeft(row, now(), tz),
    pinned: row.pinned === 1,
    signal: row.signal,
    in_queue: row.q_item_id !== null,
    analysis: analysisView(row, names, lang),
  };
}

/** One live (not archived) item of this user, or null. */
export async function liveItem(env: Env, userId: string, itemId: string): Promise<ItemRow | null> {
  return env.DB.prepare("SELECT * FROM items WHERE id = ? AND user_id = ? AND archived_at IS NULL").bind(itemId, userId).first<ItemRow>();
}

/**
 * Fetches the page of a link item and stores what was found. On failure the item is marked
 * "content could not be fetched". Called after the save was answered, and again by cron for
 * items whose first attempt never finished.
 */
export async function fetchItemContent(env: Env, item: Pick<ItemRow, "id" | "user_id" | "url" | "title" | "title_from" | "body">): Promise<void> {
  const page = item.url ? await fetchPage(env, item.url) : null;
  if (!page) {
    // Text the client already sent is content; only a link with nothing at all is "unavailable".
    await env.DB.prepare(
      `UPDATE items SET fetch_state = 'failed', content_unavailable = CASE WHEN body IS NULL OR body = '' THEN 1 ELSE 0 END
       WHERE id = ? AND user_id = ? AND fetch_state = 'pending'`,
    )
      .bind(item.id, item.user_id)
      .run();
    return;
  }
  const keepTitle = item.title_from === "client" && item.title;
  const title = keepTitle ? item.title : cleanTitle(page.title) || firstSentence(page.text) || item.title;
  const body = item.body ? item.body : page.text;
  await env.DB.prepare(
    `UPDATE items SET fetch_state = 'done', title = ?, title_from = ?, site = COALESCE(NULLIF(?, ''), site), body = ?, opening = ?,
       content_unavailable = 0
     WHERE id = ? AND user_id = ? AND fetch_state = 'pending'`,
  )
    .bind(title, keepTitle ? "client" : "fetch", page.site, body, truncate(body, OPENING_CHARS), item.id, item.user_id)
    .run();
}

/** The longest text the core stores for one item (fetched pages and text files alike). */
export function bodyMaxChars(env: Env): number {
  return num(env.BODY_MAX_CHARS, 100000);
}

/**
 * The type of the item's file. A text file's content is the item's body: it is read when the
 * item is saved; an item saved before the core did that gets it here, once (QA #20). `item` is
 * updated in place.
 */
export async function fileOfItem(env: Env, item: ItemRow): Promise<{ type: string | null }> {
  if (!item.asset_id) return { type: null };
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ? AND status = 'stored'").bind(item.asset_id, item.user_id).first<AssetRow>();
  if (!asset) return { type: null };
  if (!item.body && isTextType(asset.content_type)) {
    const text = await assetText(env, asset, bodyMaxChars(env));
    if (text) {
      item.body = text;
      item.opening = truncate(text, OPENING_CHARS);
      await env.DB.prepare("UPDATE items SET body = ?, opening = ? WHERE id = ? AND user_id = ? AND (body IS NULL OR body = '')")
        .bind(item.body, item.opening, item.id, item.user_id)
        .run();
    }
  }
  return { type: asset.content_type };
}

export function defaultSite(url: string | undefined | null): string | null {
  return url ? siteOf(url) : null;
}

export function maxExpiryDays(days: number): number {
  return Math.min(Math.max(1, Math.round(days)), LIMITS.item_expiry_max_days);
}
