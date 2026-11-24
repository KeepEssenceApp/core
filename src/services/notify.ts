// Notifications: one sentence when a built-in assistant finished an analysis or a deep read.
// Events are batched per user: wait 2 minutes after the last one, at most 10 minutes after the first.
import { now, SECOND } from "../clock";
import { LIMITS, type Env } from "../env";
import type { UserRow } from "../types";
import { parseJson } from "../util";
import { displayTitle, sharedText } from "./items";
import { sendPush } from "./push";

export type NotifyStep = "analysis" | "deep_read";

/** Statement that adds one event to the user's pending batch. */
export function notifyEventStatement(env: Env, userId: string, itemId: string, step: NotifyStep): D1PreparedStatement {
  const t = now();
  return env.DB.prepare(
    `INSERT INTO notify_batches (user_id, first_at, last_at, events)
     VALUES (?1, ?2, ?2, json_array(json_object('item_id', ?3, 'step', ?4)))
     ON CONFLICT (user_id) DO UPDATE SET last_at = ?2, events = json_insert(events, '$[#]', json_object('item_id', ?3, 'step', ?4))`,
  ).bind(userId, t, itemId, step);
}

interface Batch {
  user_id: string;
  first_at: number;
  last_at: number;
  events: string;
}

export interface Notification {
  body: string;
  count: number;
  item_id: string | null;
  kind: "analysis" | "deep_read" | "mixed";
}

/** What is left of a batch once everything the user already dealt with is dropped. Null: send nothing. */
export async function composeNotification(env: Env, user: UserRow, events: { item_id: string; step: NotifyStep }[]): Promise<Notification | null> {
  const steps = new Map<string, Set<NotifyStep>>();
  for (const e of events) {
    if (!steps.has(e.item_id)) steps.set(e.item_id, new Set());
    steps.get(e.item_id)!.add(e.step);
  }
  const ids = [...steps.keys()].slice(0, 80);
  if (ids.length === 0) return null;
  const rows = await env.DB.prepare(
    `SELECT i.id, i.title, i.kind, i.content_unavailable, i.signal, i.viewed_at, i.analysed_at,
            q.status AS q_status
     FROM items i LEFT JOIN deep_read_queue q ON q.item_id = i.id AND q.user_id = i.user_id
     WHERE i.user_id = ? AND i.archived_at IS NULL AND i.id IN (${ids.map(() => "?").join(",")})`,
  )
    .bind(user.id, ...ids)
    .all<{ id: string; title: string; kind: string; content_unavailable: number; signal: string | null; viewed_at: number | null; analysed_at: number | null; q_status: string | null }>();
  const left: { title: string; id: string; step: NotifyStep }[] = [];
  for (const row of rows.results) {
    const has = steps.get(row.id)!;
    // A deep read still counts while the item is in the queue with its report; an analysis counts
    // until the user opened it, marked it, or put it in the queue.
    const deepRead = has.has("deep_read") && row.q_status === "ready";
    const analysis = has.has("analysis") && row.analysed_at !== null && row.signal === null && row.viewed_at === null && row.q_status === null;
    if (deepRead) left.push({ id: row.id, title: displayTitle(row, user.lang), step: "deep_read" });
    else if (analysis) left.push({ id: row.id, title: displayTitle(row, user.lang), step: "analysis" });
  }
  if (left.length === 0) return null;
  if (left.length === 1) {
    const one = left[0];
    const key = one.step === "analysis" ? "notifications.one_analysis" : "notifications.one_deep_read";
    return { body: sharedText(key, user.lang).replace("{title}", one.title), count: 1, item_id: one.id, kind: one.step };
  }
  const kinds = new Set(left.map((l) => l.step));
  const kind = kinds.size > 1 ? "mixed" : left[0].step;
  const key = kind === "mixed" ? "notifications.many_mixed" : kind === "analysis" ? "notifications.many_analysis" : "notifications.many_deep_read";
  return { body: sharedText(key, user.lang).replace("{n}", String(left.length)), count: left.length, item_id: null, kind };
}

/** Sends every batch whose wait is over. Returns how many notifications went out. */
export async function sendDueNotifications(env: Env): Promise<number> {
  const t = now();
  const due = await env.DB.prepare("SELECT * FROM notify_batches WHERE last_at <= ? OR first_at <= ? LIMIT 10")
    .bind(t - LIMITS.notify_wait_seconds * SECOND, t - LIMITS.notify_max_wait_seconds * SECOND)
    .all<Batch>();
  let sent = 0;
  for (const batch of due.results) {
    // Delete first: a batch is sent at most once, and a failure is not repeated to the user.
    await env.DB.prepare("DELETE FROM notify_batches WHERE user_id = ? AND last_at = ?").bind(batch.user_id, batch.last_at).run();
    const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(batch.user_id).first<UserRow>();
    if (!user || !user.notify) continue;
    const note = await composeNotification(env, user, parseJson(batch.events, []));
    if (!note) continue;
    const targets = await env.DB.prepare(
      `SELECT p.device_id, p.endpoint, p.p256dh, p.auth FROM push_targets p
       JOIN devices d ON d.id = p.device_id AND d.user_id = p.user_id
       WHERE p.user_id = ? AND d.revoked_at IS NULL AND d.tier IN ('read', 'manage')`,
    )
      .bind(user.id)
      .all<{ device_id: string; endpoint: string; p256dh: string; auth: string }>();
    for (const target of targets.results) {
      let outcome = await sendPush(env, target, note);
      if (outcome === "failed") outcome = await sendPush(env, target, note); // one retry
      if (outcome === "gone") {
        await env.DB.prepare("DELETE FROM push_targets WHERE device_id = ? AND user_id = ?").bind(target.device_id, user.id).run();
      }
      if (outcome === "sent") sent++;
    }
  }
  return sent;
}
