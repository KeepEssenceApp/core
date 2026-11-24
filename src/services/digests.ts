// When a daily digest is due, and what it covers.
import { now } from "../clock";
import type { Env } from "../env";
import { addDays, localDay, localParts, localToUtc } from "../time";
import type { UserRow } from "../types";
import { parseJson } from "../util";

export const DIGEST_HOUR = 21;

export interface DigestDue {
  day: string;
  dueAt: number;
  /** Analyses made before this instant belong to this digest (end of `day` in the user's zone). */
  cutoff: number;
}

/** The most recent day whose 21:00 has passed in the user's time zone. */
export function digestDay(user: UserRow, t = now()): DigestDue {
  const p = localParts(t, user.timezone);
  const day = p.hour >= DIGEST_HOUR ? p.day : addDays(p.day, -1);
  return { day, dueAt: localToUtc(day, DIGEST_HOUR, user.timezone), cutoff: localToUtc(addDays(day, 1), 0, user.timezone) };
}

export interface CoveredRow {
  id: string;
  title: string;
  kind: string;
  content_unavailable: number;
  site: string | null;
  url: string | null;
  signal: string | null;
  analysed_at: number;
  unavailable: number;
  summary: string;
  key_fact: string | null;
  points: string;
  verdict: string | null;
  in_queue: number;
}

/** Analyses that no digest has covered yet: the day's, plus any from days that were missed. */
export async function coveredItems(env: Env, user: UserRow, cutoff: number): Promise<CoveredRow[]> {
  const rows = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.content_unavailable, i.site, i.url, i.signal, i.analysed_at,
            a.unavailable, a.summary, a.key_fact, a.points, a.verdict,
            (SELECT COUNT(*) FROM deep_read_queue q WHERE q.item_id = i.id AND q.user_id = i.user_id) AS in_queue
     FROM items i JOIN analyses a ON a.item_id = i.id AND a.user_id = i.user_id
     WHERE i.user_id = ? AND i.archived_at IS NULL AND i.digest_day IS NULL AND i.analysed_at IS NOT NULL AND i.analysed_at < ?
     ORDER BY i.analysed_at LIMIT 200`,
  )
    .bind(user.id, cutoff)
    .all<CoveredRow>();
  return rows.results;
}

/** The digest that should be written now, or null: its day needs analyses and must not have a digest yet. */
export async function digestDue(env: Env, user: UserRow): Promise<DigestDue | null> {
  const due = digestDay(user);
  const [done, waiting] = await env.DB.batch<{ n: number }>([
    env.DB.prepare("SELECT COUNT(*) AS n FROM digests WHERE user_id = ? AND day >= ? AND status = 'done'").bind(user.id, due.day),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND archived_at IS NULL AND digest_day IS NULL
       AND analysed_at IS NOT NULL AND analysed_at < ?`,
    ).bind(user.id, due.cutoff),
  ]);
  if ((done.results[0]?.n ?? 0) > 0 || (waiting.results[0]?.n ?? 0) === 0) return null;
  return due;
}

export function coversOf(rows: CoveredRow[], user: UserRow, day: string): string[] {
  const days = new Set(rows.map((r) => localDay(r.analysed_at, user.timezone)));
  days.add(day);
  return [...days].filter((d) => d <= day).sort();
}

export interface DigestEntry {
  item_id: string;
  title: string;
  verdict: string | null;
}

export interface DigestRow {
  user_id: string;
  day: string;
  status: string;
  summary: string | null;
  question: string | null;
  worth: string | null;
  entries: string | null;
  covers: string | null;
  assistant_id: string | null;
  due_at: number | null;
  created_at: number | null;
  read_at: number | null;
  claim_id: string | null;
  claim_expires_at: number | null;
}

export function digestParts(row: DigestRow) {
  return {
    worth: parseJson<{ item_id: string; line: string }[]>(row.worth, []),
    entries: parseJson<DigestEntry[]>(row.entries, []),
  };
}
