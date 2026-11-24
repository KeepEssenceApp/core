// Notes: what stays. Written by an assistant after the user said so, or pasted back by the user.
import { now } from "../clock";
import type { Env } from "../env";
import { err } from "../errors";
import type { UserRow } from "../types";
import { iso, newId, parseJson, truncate } from "../util";
import { refStatement } from "./assets";
import { countStatement, displayTitle, liveItem } from "./items";
import { likePattern } from "./work";

export interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  body: string;
  item_id: string | null;
  item_title: string | null;
  item_url: string | null;
  digest_day: string | null;
  sources: string;
  asset_ids: string;
  assistant_id: string | null;
  assistant_name: string;
  submitted_by: "assistant" | "user";
  created_at: number;
}

export function noteView(n: NoteRow) {
  return {
    id: n.id,
    title: n.title,
    body: n.body,
    created_at: iso(n.created_at),
    assistant: { id: n.assistant_id ?? "", name: n.assistant_name, ...(n.submitted_by === "user" ? { submitted_by_user: true } : {}) },
    origin: n.item_title !== null || n.item_id ? { item_id: n.item_id, item_title: n.item_title ?? "", item_url: n.item_url, digest_day: n.digest_day } : null,
    sources: parseJson<{ title: string; url?: string | null }[]>(n.sources, []).map((s) => ({ title: s.title, url: s.url ?? null })),
    asset_ids: parseJson<string[]>(n.asset_ids, []),
  };
}

export function noteMarkdown(n: NoteRow): string {
  const sources = parseJson<{ title: string; url?: string | null }[]>(n.sources, []);
  let md = `# ${n.title}\n\n${n.body.trim()}\n`;
  if (sources.length > 0) {
    md += "\n---\n\n" + sources.map((s) => (s.url ? `- [${s.title}](${s.url})` : `- ${s.title}`)).join("\n") + "\n";
  }
  return md;
}

export interface NewNote {
  title: string;
  body: string;
  itemId?: string;
  sources?: { title: string; url?: string }[];
  assetIds?: string[];
  assistantId: string | null;
  assistantName: string;
  submittedBy: "assistant" | "user";
}

/**
 * Stores a note. If it came out of an item, the note remembers the item's title, address and
 * digest day (so it stands on its own after the item is gone), and the item leaves the queue.
 */
export async function createNote(env: Env, user: UserRow, input: NewNote): Promise<NoteRow> {
  const t = now();
  const item = input.itemId ? await liveItem(env, user.id, input.itemId) : null;
  if (input.itemId && !item) throw err("not_found");
  const assetIds = [...new Set(input.assetIds ?? [])];
  if (assetIds.length > 0) {
    const rows = await env.DB.prepare(
      `SELECT id FROM assets WHERE user_id = ? AND status = 'stored' AND id IN (${assetIds.map(() => "?").join(",")})`,
    )
      .bind(user.id, ...assetIds)
      .all<{ id: string }>();
    if (rows.results.length !== assetIds.length) {
      throw err("bad_request", "有附件不存在或还没传完。", "An attachment does not exist or was not uploaded completely.");
    }
  }
  const note: NoteRow = {
    id: newId("note"),
    user_id: user.id,
    title: input.title.trim(),
    body: input.body,
    item_id: item?.id ?? null,
    item_title: item ? displayTitle(item, user.lang) : null,
    item_url: item?.url ?? null,
    digest_day: item?.digest_day ?? null,
    sources: JSON.stringify(input.sources ?? []),
    asset_ids: JSON.stringify(assetIds),
    assistant_id: input.assistantId,
    assistant_name: input.assistantName,
    submitted_by: input.submittedBy,
    created_at: t,
  };
  const statements = [
    env.DB.prepare(
      `INSERT INTO notes (id, user_id, title, body, item_id, item_title, item_url, digest_day, sources, asset_ids, assistant_id, assistant_name, submitted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(note.id, user.id, note.title, note.body, note.item_id, note.item_title, note.item_url, note.digest_day, note.sources, note.asset_ids, note.assistant_id, note.assistant_name, note.submitted_by, t),
    countStatement(env, user, "notes"),
    ...assetIds.map((id) => refStatement(env, user.id, id, 1)),
  ];
  if (item) statements.push(...leaveQueueStatements(env, user.id, item.id));
  await env.DB.batch(statements);
  // The quick-find index is best effort: without it the lookup falls back to LIKE.
  try {
    await env.DB.prepare("INSERT INTO notes_fts (note_id, user_id, title, body) VALUES (?, ?, ?, ?)").bind(note.id, user.id, note.title, note.body).run();
  } catch {}
  return note;
}

/** Statements that take an item out of the deep-read queue; its report goes with it. */
export function leaveQueueStatements(env: Env, userId: string, itemId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM deep_read_queue WHERE user_id = ? AND item_id = ?").bind(userId, itemId),
    env.DB.prepare("DELETE FROM submissions WHERE user_id = ? AND kind = 'deep_read' AND ref = ?").bind(userId, itemId),
    env.DB.prepare("UPDATE items SET queue_holds = 0 WHERE user_id = ? AND id = ?").bind(userId, itemId),
  ];
}

/** Quick find: notes whose title or body contain the words. FTS5 first, LIKE when that is not possible. */
export async function findNotes(env: Env, userId: string, q: string, limit: number, offset: number): Promise<NoteRow[]> {
  const words = q.trim();
  if ([...words].length >= 3) {
    try {
      const match = words
        .split(/\s+/)
        .filter((w) => [...w].length >= 3)
        .map((w) => '"' + w.replace(/"/g, '""') + '"')
        .join(" AND ");
      if (match && match.split(" AND ").length === words.split(/\s+/).length) {
        const rows = await env.DB.prepare(
          `SELECT n.* FROM notes_fts f JOIN notes n ON n.id = f.note_id AND n.user_id = f.user_id
           WHERE notes_fts MATCH ? AND f.user_id = ? ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
        )
          .bind(match, userId, limit, offset)
          .all<NoteRow>();
        return rows.results;
      }
    } catch {
      // fall through to LIKE
    }
  }
  const like = likePattern(words);
  const rows = await env.DB.prepare(
    `SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(userId, like, like, limit, offset)
    .all<NoteRow>();
  return rows.results;
}

export function noteSummary(n: NoteRow) {
  return { id: n.id, title: n.title, excerpt: truncate(n.body.replace(/\s+/g, " ").trim(), 160), created_at: iso(n.created_at) };
}
