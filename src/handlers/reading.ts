// Reading: digests, the deep-read queue, deep-dive requests, notes, status, calendar, counts, usage.
import { DAY, now } from "../clock";
import { err } from "../errors";
import { addDays, addMonths, daysInMonth, isDay, localDay, localParts } from "../time";
import { NO_CONTENT, ok, type AssistantRow, type Cx, type Handler, type UserRow } from "../types";
import { decodeCursor, encodeCursor, iso, parseJson } from "../util";
import { listAssistants } from "../services/accounts";
import { DIGEST_HOUR, digestParts, type DigestRow } from "../services/digests";
import { idempotent } from "../services/guard";
import { displayTitle, liveItem, namesOf, signature } from "../services/items";
import { createNote, findNotes, leaveQueueStatements, noteMarkdown, noteSummary, noteView, type NoteRow } from "../services/notes";
import { recordDeepDive } from "../services/work";
import type { Env } from "../env";

// ---------------------------------------------------------------- digests

export const listDigests: Handler = async (cx) => {
  const limit: number = cx.query.limit ?? 20;
  const offset = decodeCursor(cx.query.cursor);
  const rows = await cx.env.DB.prepare("SELECT day, read_at FROM digests WHERE user_id = ? AND status = 'done' ORDER BY day DESC LIMIT ? OFFSET ?")
    .bind(cx.user!.id, limit + 1, offset)
    .all<{ day: string; read_at: number | null }>();
  return ok({
    digests: rows.results.slice(0, limit).map((r) => ({ day: r.day, read: r.read_at !== null })),
    next_cursor: rows.results.length > limit ? encodeCursor(offset + limit) : null,
  });
};

async function loadDigest(cx: Cx, day: string): Promise<DigestRow> {
  const row =
    day === "latest"
      ? await cx.env.DB.prepare("SELECT * FROM digests WHERE user_id = ? AND status = 'done' ORDER BY day DESC LIMIT 1").bind(cx.user!.id).first<DigestRow>()
      : await cx.env.DB.prepare("SELECT * FROM digests WHERE user_id = ? AND day = ? AND status = 'done'").bind(cx.user!.id, day).first<DigestRow>();
  if (!row) throw err("not_found");
  return row;
}

/**
 * One digest. The core stores what the assistant handed in and arranges the two lists now,
 * from what the user did since: a "worth" line the user marked or queued moves to the rest.
 */
export const getDigest: Handler = async (cx) => {
  const row = await loadDigest(cx, cx.path.day);
  const { worth: lines, entries } = digestParts(row);
  const ids = entries.map((e) => e.item_id);
  const live = new Map<string, { signal: string | null; in_queue: boolean }>();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    const rows = await cx.env.DB.prepare(
      `SELECT i.id, i.signal, q.item_id AS q FROM items i LEFT JOIN deep_read_queue q ON q.item_id = i.id AND q.user_id = i.user_id
       WHERE i.user_id = ? AND i.archived_at IS NULL AND i.id IN (${chunk.map(() => "?").join(",")})`,
    )
      .bind(cx.user!.id, ...chunk)
      .all<{ id: string; signal: string | null; q: string | null }>();
    for (const r of rows.results) live.set(r.id, { signal: r.signal, in_queue: r.q !== null });
  }
  const lineOf = new Map(lines.map((l) => [l.item_id, l.line]));
  const worth: unknown[] = [];
  const rest: unknown[] = [];
  for (const e of entries) {
    const state = live.get(e.item_id);
    const line = lineOf.get(e.item_id);
    const handled = state ? state.signal !== null || state.in_queue : false;
    if (line !== undefined && !handled) {
      // A deleted item keeps its line; it just cannot be opened any more.
      worth.push({ item_id: e.item_id, title: e.title, line, verdict: e.verdict ?? undefined, available: state !== undefined, in_queue: false });
    } else {
      rest.push({
        item_id: e.item_id,
        title: e.title,
        signal: state?.signal ?? null,
        in_queue: state?.in_queue ?? false,
        available: state !== undefined,
        can_restore: line !== undefined && handled,
      });
    }
  }
  const [prev, next] = await cx.env.DB.batch<{ day: string }>([
    cx.env.DB.prepare("SELECT day FROM digests WHERE user_id = ? AND status = 'done' AND day < ? ORDER BY day DESC LIMIT 1").bind(cx.user!.id, row.day),
    cx.env.DB.prepare("SELECT day FROM digests WHERE user_id = ? AND status = 'done' AND day > ? ORDER BY day LIMIT 1").bind(cx.user!.id, row.day),
  ]);
  const names = namesOf(await listAssistants(cx.env, cx.user!.id, true));
  return ok({
    day: row.day,
    read: row.read_at !== null,
    counts: { saved: entries.length, worth: worth.length },
    summary: row.summary ?? "",
    worth,
    rest,
    question: row.question ?? "",
    assistant: signature(names, row.assistant_id),
    previous_day: prev.results[0]?.day ?? null,
    next_day: next.results[0]?.day ?? null,
  });
};

/** "Read" is a mark and nothing else. */
export const markDigestRead: Handler = async (cx) => {
  const row = await loadDigest(cx, cx.path.day);
  await cx.env.DB.prepare("UPDATE digests SET read_at = COALESCE(read_at, ?) WHERE user_id = ? AND day = ?").bind(now(), cx.user!.id, row.day).run();
  return NO_CONTENT;
};

// ---------------------------------------------------------------- deep-read queue

interface QueueJoined {
  item_id: string;
  added_at: number;
  status: string;
  report: string | null;
  assistant_id: string | null;
  entry: string | null;
  went_at: number | null;
  fetched_at: number | null;
  claim_expires_at: number | null;
  claim_id: string | null;
  title: string;
  kind: string;
  content_unavailable: number;
}

const QUEUE_SQL = `SELECT q.*, i.title, i.kind, i.content_unavailable FROM deep_read_queue q
  JOIN items i ON i.id = q.item_id AND i.user_id = q.user_id WHERE q.user_id = ? AND i.archived_at IS NULL`;

function queueView(q: QueueJoined, user: UserRow, names: Map<string, string>) {
  // Only what the core can see: waiting, being read, ready. `none` when nobody is set to read.
  const state =
    q.status === "ready" ? "ready" : !user.role_deep_read ? "none" : q.claim_id && (q.claim_expires_at ?? 0) > now() ? "reading" : "waiting";
  const report = q.status === "ready" ? parseJson<any>(q.report, null) : null;
  return {
    item_id: q.item_id,
    title: displayTitle(q, user.lang),
    added_at: iso(q.added_at),
    deep_read: state,
    report: report ? { ...report, assistant: signature(names, q.assistant_id) } : null,
    went_at: iso(q.went_at),
    fetched_at: iso(q.fetched_at),
    entry: q.entry,
  };
}

export const listQueue: Handler = async (cx) => {
  const rows = await cx.env.DB.prepare(`${QUEUE_SQL} ORDER BY q.added_at DESC LIMIT 200`).bind(cx.user!.id).all<QueueJoined>();
  const names = namesOf(await listAssistants(cx.env, cx.user!.id, true));
  return ok({ entries: rows.results.map((q) => queueView(q, cx.user!, names)) });
};

export const addToQueue: Handler = async (cx) => {
  const item = await liveItem(cx.env, cx.user!.id, cx.path.item_id);
  if (!item) throw err("not_found");
  const t = now();
  await cx.env.DB.batch([
    cx.env.DB.prepare("INSERT OR IGNORE INTO deep_read_queue (item_id, user_id, added_at, status, last_activity_at) VALUES (?, ?, ?, 'waiting', ?)").bind(item.id, cx.user!.id, t, t),
    // While it is in the queue the item is not archived (never past its hard limit of one year).
    cx.env.DB.prepare("UPDATE items SET queue_holds = 1 WHERE id = ? AND user_id = ?").bind(item.id, cx.user!.id),
  ]);
  const row = await cx.env.DB.prepare(`${QUEUE_SQL} AND q.item_id = ?`).bind(cx.user!.id, item.id).first<QueueJoined>();
  return ok(queueView(row!, cx.user!, namesOf(await listAssistants(cx.env, cx.user!.id, true))));
};

export const removeFromQueue: Handler = async (cx) => {
  await cx.env.DB.batch(leaveQueueStatements(cx.env, cx.user!.id, cx.path.item_id));
  return NO_CONTENT;
};

// ---------------------------------------------------------------- deep dive

/** The user goes to an assistant. The opening line carries no content; the assistant fetches it. */
export const startDeepDive: Handler = async (cx) => {
  const user = cx.user!;
  const item = await liveItem(cx.env, user.id, cx.body.item_id);
  if (!item) throw err("not_found");
  const wanted = cx.body.assistant_id ?? user.role_deep_dive;
  const assistant = wanted ? (await listAssistants(cx.env, user.id)).find((a) => a.id === wanted) : undefined;
  if (!assistant || !parseJson<string[]>(assistant.steps, []).includes("deep_dive")) {
    throw err("conflict", "还没有可以深挖的助手：先接入一只，或在助手设置里选一只缺省的。", "There is no assistant to deep dive with yet: connect one, or choose a default in the assistant settings.");
  }
  const line = await recordDeepDive(cx.env, user, item, assistant.id);
  const queue = await cx.env.DB.prepare("UPDATE deep_read_queue SET went_at = ? WHERE user_id = ? AND item_id = ? RETURNING entry, assistant_id")
    .bind(now(), user.id, item.id)
    .first<{ entry: string | null; assistant_id: string | null }>();
  // An entry exists only when this very assistant attached one to its deep-read report.
  const entry = queue && queue.assistant_id === assistant.id ? queue.entry : null;
  return ok(
    {
      assistant: { id: assistant.id, name: assistant.name },
      opening_line: line,
      open_url: entry && /^https?:\/\/\S+$/i.test(entry.trim()) ? entry.trim() : null,
      entry,
    },
    201,
  );
};

// ---------------------------------------------------------------- notes

export const listNotes: Handler = async (cx) => {
  const limit: number = cx.query.limit ?? 20;
  const offset = decodeCursor(cx.query.cursor);
  const q = (cx.query.q ?? "").trim();
  const rows = q
    ? await findNotes(cx.env, cx.user!.id, q, limit + 1, offset)
    : (
        await cx.env.DB.prepare("SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?")
          .bind(cx.user!.id, limit + 1, offset)
          .all<NoteRow>()
      ).results;
  return ok({ notes: rows.slice(0, limit).map(noteSummary), next_cursor: rows.length > limit ? encodeCursor(offset + limit) : null });
};

/** The user pastes back what came out of a deep dive. The signature is still the assistant they talked to. */
export const pasteNote: Handler = async (cx) =>
  idempotent(cx.env, cx.user!.id, "pasteNote", cx.idemKey, async () => {
    const user = cx.user!;
    const assistants = await listAssistants(cx.env, user.id);
    let assistant: AssistantRow | undefined;
    if (cx.body.assistant_id) {
      assistant = assistants.find((a) => a.id === cx.body.assistant_id);
      if (!assistant) throw err("bad_request", "助手清单里没有这只助手。", "There is no such assistant in your list.");
    } else {
      const last = cx.body.item_id
        ? await cx.env.DB.prepare("SELECT assistant_id FROM deep_dive_requests WHERE user_id = ? AND item_id = ? ORDER BY last_activity_at DESC LIMIT 1")
            .bind(user.id, cx.body.item_id)
            .first<{ assistant_id: string }>()
        : null;
      assistant = assistants.find((a) => a.id === (last?.assistant_id ?? user.role_deep_dive));
    }
    const note = await createNote(cx.env, user, {
      title: cx.body.title,
      body: cx.body.body,
      itemId: cx.body.item_id,
      assetIds: cx.body.asset_ids,
      assistantId: assistant?.id ?? null,
      assistantName: assistant?.name ?? "",
      submittedBy: "user",
    });
    return ok(noteView(note), 201);
  });

export const getNote: Handler = async (cx) => {
  const note = await cx.env.DB.prepare("SELECT * FROM notes WHERE id = ? AND user_id = ?").bind(cx.path.id, cx.user!.id).first<NoteRow>();
  if (!note) throw err("not_found");
  const accept = cx.request?.headers.get("accept") ?? "";
  if (accept.includes("text/markdown") && !accept.includes("application/json")) {
    return new Response(noteMarkdown(note), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  }
  return ok(noteView(note));
};

// ---------------------------------------------------------------- status

export const getStatus: Handler = async (cx) => {
  const user = cx.user!;
  const t = now();
  const local = localParts(t, user.timezone);
  const [working, saved, waiting, digest, analysed] = await cx.env.DB.batch<any>([
    cx.env.DB.prepare("SELECT DISTINCT assistant_id FROM claims WHERE user_id = ? AND status = 'active' AND expires_at > ?").bind(user.id, t),
    cx.env.DB.prepare("SELECT COALESCE(SUM(saved), 0) AS n FROM daily_counts WHERE user_id = ? AND day = ?").bind(user.id, local.day),
    cx.env.DB.prepare("SELECT COUNT(*) AS n, MIN(CASE WHEN pinned = 0 THEN expires_at END) AS oldest FROM items WHERE user_id = ? AND archived_at IS NULL AND analysed_at IS NULL").bind(user.id),
    cx.env.DB.prepare("SELECT 1 AS x FROM digests WHERE user_id = ? AND day = ? AND status = 'done'").bind(user.id, local.day),
    cx.env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ? AND archived_at IS NULL AND analysed_at IS NOT NULL AND digest_day IS NULL").bind(user.id),
  ]);
  const busy = new Set(working.results.map((r: any) => r.assistant_id));
  const assistants = (await listAssistants(cx.env, user.id)).filter((a) => a.built_in !== "dispatch");
  let reason: string | null = null;
  if (digest.results.length === 0) {
    if (local.hour < DIGEST_HOUR) reason = "not_yet_time";
    else if (!user.role_digest) reason = "no_assistant";
    else if ((analysed.results[0]?.n ?? 0) === 0) reason = "nothing_analysed";
    else reason = "waiting_for_assistant";
  }
  const oldest: number | null = waiting.results[0]?.oldest ?? null;
  return ok({
    assistants: assistants.map((a) => ({
      id: a.id,
      name: a.name,
      state: busy.has(a.id) ? "working" : a.last_seen_at === null ? "never" : t - a.last_seen_at <= DAY ? "recent" : "quiet",
      last_seen_at: iso(a.last_seen_at),
    })),
    saved_today: saved.results[0]?.n ?? 0,
    waiting: waiting.results[0]?.n ?? 0,
    oldest_waiting_deleted_on: oldest ? localDay(oldest, user.timezone) : null,
    no_digest_reason: reason,
  });
};

// ---------------------------------------------------------------- calendar and counts

export type Mark = "empty" | "saved" | "digest_unread" | "digest_read" | "note" | "future";

export interface CalendarMonth {
  month: string;
  today: string;
  days: { day: string; mark: Mark; has_digest: boolean }[];
  counts: { saved: number; digests: number; read: number; notes: number };
}

/** One month, one mark per day. It records what happened; deleting items later does not change it. */
export async function calendarMonth(env: Env, user: UserRow, month: string): Promise<CalendarMonth> {
  const today = localDay(now(), user.timezone);
  const first = `${month}-01`;
  const last = `${month}-31`;
  const [counts, digests] = await env.DB.batch<any>([
    env.DB.prepare("SELECT day, SUM(saved) AS saved, SUM(notes) AS notes FROM daily_counts WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day").bind(user.id, first, last),
    env.DB.prepare("SELECT day, read_at FROM digests WHERE user_id = ? AND status = 'done' AND day BETWEEN ? AND ?").bind(user.id, first, last),
  ]);
  const byDay = new Map<string, { saved: number; notes: number }>(counts.results.map((r: any) => [r.day, r]));
  const digestBy = new Map<string, number | null>(digests.results.map((r: any) => [r.day, r.read_at]));
  const total = { saved: 0, digests: 0, read: 0, notes: 0 };
  const days = daysInMonth(month).map((day) => {
    const c = byDay.get(day);
    const hasDigest = digestBy.has(day);
    const read = hasDigest && digestBy.get(day) !== null;
    total.saved += c?.saved ?? 0;
    total.notes += c?.notes ?? 0;
    if (hasDigest) total.digests++;
    if (read) total.read++;
    const mark: Mark =
      day > today ? "future" : (c?.notes ?? 0) > 0 ? "note" : read ? "digest_read" : hasDigest ? "digest_unread" : (c?.saved ?? 0) > 0 ? "saved" : "empty";
    return { day, mark, has_digest: hasDigest };
  });
  return { month, today, days, counts: total };
}

export const getCalendar: Handler = async (cx) => {
  const user = cx.user!;
  const current = localDay(now(), user.timezone).slice(0, 7);
  const month: string = cx.query.month ?? current;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw err("bad_request", "月份写成 YYYY-MM。", "Write the month as YYYY-MM.");
  const cal = await calendarMonth(cx.env, user, month);
  const firstMonth = localDay(user.created_at, user.timezone).slice(0, 7);
  return ok({
    ...cal,
    previous_month: month > firstMonth ? addMonths(month, -1) : null,
    next_month: month < current ? addMonths(month, 1) : null,
  });
};

export const getStats: Handler = async (cx) => {
  const user = cx.user!;
  const n: number = cx.query.days ?? 30;
  const today = localDay(now(), user.timezone);
  const from = addDays(today, -(n - 1));
  const rows = await cx.env.DB.prepare("SELECT * FROM daily_counts WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day").bind(user.id, from, today).all<any>();
  const days = new Map<string, { day: string; saved: number; analysed: number; digests: number; notes: number; by_source: Record<string, number> }>();
  for (let i = 0; i < n; i++) {
    const day = addDays(today, -i);
    days.set(day, { day, saved: 0, analysed: 0, digests: 0, notes: 0, by_source: {} });
  }
  for (const r of rows.results) {
    const d = days.get(r.day);
    if (!d) continue;
    d.saved += r.saved;
    d.analysed += r.analysed;
    d.digests += r.digests;
    d.notes += r.notes;
    if (r.source && r.saved > 0) d.by_source[r.source] = (d.by_source[r.source] ?? 0) + r.saved;
  }
  return ok({ days: [...days.values()] });
};

export const getUsage: Handler = async (cx) => {
  const since = now() - (cx.query.days ?? 30) * DAY;
  const rows = await cx.env.DB.prepare(
    `SELECT u.assistant_id, a.name, SUM(u.calls) AS calls, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens,
            SUM(u.items) AS items, MAX(u.self_reported) AS self_reported
     FROM usage_records u LEFT JOIN assistants a ON a.id = u.assistant_id AND a.user_id = u.user_id
     WHERE u.user_id = ? AND u.created_at >= ? GROUP BY u.assistant_id ORDER BY a.connected_at`,
  )
    .bind(cx.user!.id, since)
    .all<any>();
  return ok({
    assistants: rows.results.map((r) => ({
      assistant_id: r.assistant_id,
      name: r.name ?? "",
      calls: r.calls,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      items: r.items,
      self_reported: r.self_reported === 1,
    })),
  });
};

export { isDay };
