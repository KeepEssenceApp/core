// Saving, and everything a reading client does with items.
import { DAY, MINUTE, now } from "../clock";
import { LIMITS, num, type Env } from "../env";
import { err } from "../errors";
import { NO_CONTENT, ok, type Cx, type Handler, type ItemRow, type Result } from "../types";
import { decodeCursor, encodeCursor, firstSentence, iso, newId, parseJson, truncate } from "../util";
import { listAssistants } from "../services/accounts";
import { assetText, deleteIfUnreferenced, isTextType, refStatement, type AssetRow } from "../services/assets";
import { idempotent, rateLimit } from "../services/guard";
import {
  bodyMaxChars,
  cleanTitle,
  countStatement,
  defaultSite,
  endsAt,
  fetchItemContent,
  ITEM_FROM,
  ITEM_SELECT,
  itemView,
  liveItem,
  maxExpiryDays,
  namesOf,
  OPENING_CHARS,
  sharedText,
  urlKey,
  type ItemJoined,
} from "../services/items";
import { likePattern } from "../services/work";

function saveResult(cx: Cx, status: "saved" | "duplicate", itemId: string, key: string, imageStored?: boolean) {
  return {
    status,
    item_id: itemId,
    message_key: key,
    message: sharedText(`save_messages.${key}`, cx.lang),
    ...(imageStored === undefined ? {} : { image_stored: imageStored }),
  };
}

async function save(cx: Cx): Promise<Result> {
  const env = cx.env;
  const user = cx.user!;
  const b = cx.body as { kind: ItemRow["kind"]; url?: string; title?: string; text?: string; asset_id?: string; entry?: string };
  const t = now();
  if (b.url !== undefined && !/^https?:\/\//i.test(b.url)) {
    throw err("bad_request", "网址必须以 http:// 或 https:// 开头。", "The address must start with http:// or https://.");
  }
  let key: string | null = null;
  if (b.kind === "link") {
    if (!b.url) throw err("bad_request", "存入链接需要 url。", "Saving a link needs `url`.");
    try {
      key = urlKey(b.url);
    } catch {
      throw err("bad_request", "网址格式不对。", "The address is malformed.");
    }
    const existing = await env.DB.prepare("SELECT id FROM items WHERE user_id = ? AND url_key = ? AND archived_at IS NULL").bind(user.id, key).first<{ id: string }>();
    if (existing) return ok(saveResult(cx, "duplicate", existing.id, "duplicate"));
  }
  let text = (b.text ?? "").trim();
  if (b.kind === "text" && !text) throw err("bad_request", "存入文字需要 text。", "Saving text needs `text`.");
  let asset: AssetRow | null = null;
  let imageStored: boolean | undefined;
  if (b.kind === "image" || b.kind === "file") {
    if (!b.asset_id) throw err("bad_request", "存入图片或文件需要 asset_id。", "Saving an image or a file needs `asset_id`.");
    asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").bind(b.asset_id, user.id).first<AssetRow>();
    if (!asset) throw err("bad_request", "没有这个附件。", "There is no such attachment.");
    if (asset.status === "pending") throw err("bad_request", "附件还没传完。", "The attachment was not uploaded completely.");
    imageStored = asset.status === "stored";
    // A text file is read here, once: its content is the item's body, so that triage and every
    // assistant get the text itself (QA #20). Images and PDFs stay files.
    if (imageStored && isTextType(asset.content_type)) {
      const fileText = await assetText(env, asset, bodyMaxChars(env));
      if (fileText) text = truncate(text ? `${text}\n\n${fileText}` : fileText, bodyMaxChars(env));
    }
  }

  const id = newId("itm");
  const clientTitle = cleanTitle(b.title);
  const site = defaultSite(b.url);
  const title = clientTitle || firstSentence(text) || (b.kind === "link" ? (site ?? "") : "");
  const fetchNeeded = b.kind === "link" && (!text || !clientTitle);
  const source = cx.device!.client + (b.entry ? "/" + b.entry.replace(/[^\w.-]/g, "").slice(0, 40) : "");
  const days = LIMITS.item_expiry_default_days;
  const statements = [
    env.DB.prepare(
      `INSERT INTO items (id, user_id, kind, url, url_key, title, title_from, site, opening, body, asset_id, source, content_unavailable,
         fetch_state, expiry_days, expires_at, hard_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      user.id,
      b.kind,
      b.url ?? null,
      key,
      title,
      clientTitle ? "client" : "derived",
      site,
      truncate(text, OPENING_CHARS),
      text || null,
      imageStored ? asset!.id : null,
      source,
      // An image whose bytes were refused for quota has nothing to read.
      imageStored === false && !text ? 1 : 0,
      fetchNeeded ? "pending" : "none",
      days,
      t + days * DAY,
      t + LIMITS.item_expiry_max_days * DAY,
      t,
    ),
    env.DB.prepare("INSERT INTO item_tags (item_id, user_id, kind, value, set_by) VALUES (?, ?, 'source', ?, 'core')").bind(id, user.id, source),
    countStatement(env, user, "saved", source, t),
  ];
  if (imageStored) statements.push(refStatement(env, user.id, asset!.id, 1));
  try {
    await env.DB.batch(statements);
  } catch (e) {
    // Two saves of the same address at the same moment: the second one is the duplicate.
    if (key && String(e).includes("UNIQUE")) {
      const existing = await env.DB.prepare("SELECT id FROM items WHERE user_id = ? AND url_key = ? AND archived_at IS NULL").bind(user.id, key).first<{ id: string }>();
      if (existing) return ok(saveResult(cx, "duplicate", existing.id, "duplicate"));
    }
    throw e;
  }
  if (fetchNeeded) {
    // The answer does not wait for the page. Cron picks the item up if this never finishes.
    const job = fetchItemContent(env, { id, user_id: user.id, url: b.url!, title, title_from: clientTitle ? "client" : "derived", body: text || null }).catch(() => {});
    if (cx.exec) cx.exec.waitUntil(job);
  }
  return ok(saveResult(cx, "saved", id, imageStored === false ? "saved_image_skipped_quota" : "saved", imageStored), 201);
}

export const saveItem: Handler = async (cx) => {
  await rateLimit(cx.env, `save:${cx.device!.id}`, num(cx.env.SAVE_RATE_PER_MINUTE, 120), MINUTE);
  return idempotent(cx.env, cx.user!.id, "saveItem", cx.idemKey, () => save(cx));
};

async function names(cx: Cx) {
  return namesOf(await listAssistants(cx.env, cx.user!.id, true));
}

export const listItems: Handler = async (cx) => {
  const limit: number = cx.query.limit ?? 20;
  const offset = decodeCursor(cx.query.cursor);
  const state = cx.query.state as "today" | "digested" | "pinned";
  const where = { today: "i.digest_day IS NULL", digested: "i.digest_day IS NOT NULL", pinned: "i.pinned = 1" }[state];
  // Today: analyses first, newest first; items not analysed yet come after.
  const order = state === "today" ? "(i.analysed_at IS NULL), COALESCE(i.analysed_at, i.created_at) DESC, i.id" : "i.created_at DESC, i.id";
  const rows = await cx.env.DB.prepare(
    `SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE i.user_id = ? AND i.archived_at IS NULL AND ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(cx.user!.id, limit + 1, offset)
    .all<ItemJoined>();
  const n = await names(cx);
  return ok({
    items: rows.results.slice(0, limit).map((r) => itemView(r, n, cx.lang)),
    next_cursor: rows.results.length > limit ? encodeCursor(offset + limit) : null,
  });
};

/** Keyword lookup over items that still exist. Archived items never match. */
export const searchItems: Handler = async (cx) => {
  const like = likePattern(cx.query.q.trim());
  const rows = await cx.env.DB.prepare(
    `SELECT ${ITEM_SELECT} ${ITEM_FROM} WHERE i.user_id = ? AND i.archived_at IS NULL
     AND (i.title LIKE ? ESCAPE '\\' OR i.opening LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\')
     ORDER BY i.created_at DESC LIMIT ?`,
  )
    .bind(cx.user!.id, like, like, like, cx.query.limit ?? 20)
    .all<ItemJoined>();
  const n = await names(cx);
  return ok({ items: rows.results.map((r) => itemView(r, n, cx.lang)) });
};

async function detail(cx: Cx, id: string) {
  const [row, tags] = await cx.env.DB.batch<any>([
    cx.env.DB.prepare(`SELECT ${ITEM_SELECT}, i.body ${ITEM_FROM} WHERE i.user_id = ? AND i.id = ? AND i.archived_at IS NULL`).bind(cx.user!.id, id),
    cx.env.DB.prepare("SELECT kind, value, set_by FROM item_tags WHERE user_id = ? AND item_id = ? ORDER BY kind").bind(cx.user!.id, id),
  ]);
  const item = row.results[0] as (ItemJoined & { body: string | null }) | undefined;
  if (!item) throw err("not_found");
  const n = await names(cx);
  // Who decided each value: the user, the sorting step, or nobody yet (the default stands).
  const setBy = (kind: string): "user" | "triage" | "default" => {
    const by = (tags.results as { kind: string; set_by: string }[]).find((t) => t.kind === kind)?.set_by;
    return by === "user" ? "user" : by === "triage" ? "triage" : "default";
  };
  return {
    ...itemView(item, n, cx.lang),
    retention_set_by: item.pinned ? "user" : setBy("expiry"),
    assistant_set_by: setBy("assistant"),
    body: item.body,
    asset_id: item.asset_id,
    // A kept item has no end date, so its expiry tag does not apply and is not listed (QA #7).
    tags: (tags.results as { kind: string; value: string; set_by: string }[])
      .filter((t) => !(item.pinned && t.kind === "expiry"))
      .map((t) => `${t.kind}:${t.kind === "assistant" ? (n.get(t.value) ?? t.value) : t.value}`),
    expiry_days: item.pinned ? null : item.expiry_days,
    expires_at: iso(endsAt(item)),
  };
}

export const getItem: Handler = async (cx) => {
  const view = await detail(cx, cx.path.id);
  if (view.analysis) {
    // Opening an analysed item counts as "the user has seen it" for notifications.
    await cx.env.DB.prepare("UPDATE items SET viewed_at = ? WHERE id = ? AND user_id = ? AND viewed_at IS NULL").bind(now(), view.id, cx.user!.id).run();
  }
  return ok(view);
};

function userTag(env: Env, userId: string, itemId: string, kind: string, value: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO item_tags (item_id, user_id, kind, value, set_by) VALUES (?, ?, ?, ?, 'user')
     ON CONFLICT (item_id, kind) DO UPDATE SET value = excluded.value, set_by = 'user'`,
  ).bind(itemId, userId, kind, value);
}

/**
 * Statements that record the item's retention, and its assistant when it has one, as set by the
 * user. Triage never overwrites a user-set tag, so after any edit by the user neither value moves.
 */
function userSetStatements(env: Env, userId: string, itemId: string, expiryDays: number, dispatchTo: string | null): D1PreparedStatement[] {
  const out = [userTag(env, userId, itemId, "expiry", String(expiryDays))];
  if (dispatchTo) out.push(userTag(env, userId, itemId, "assistant", dispatchTo));
  return out;
}

/**
 * The user changes who analyses the item and how long it is kept. Either edit protects both
 * values from a later triage. Days chosen on a kept item give it an end date again, counted from now.
 */
export const updateItem: Handler = async (cx) => {
  const item = await liveItem(cx.env, cx.user!.id, cx.path.id);
  if (!item) throw err("not_found");
  const statements: D1PreparedStatement[] = [];
  let days = item.expiry_days;
  let dispatchTo = item.dispatch_to;
  if (cx.body.expiry_days !== undefined) {
    days = maxExpiryDays(cx.body.expiry_days);
    if (item.pinned) {
      const expires = now() + days * DAY;
      statements.push(
        cx.env.DB.prepare("UPDATE items SET pinned = 0, expiry_days = ?, expires_at = ?, hard_expires_at = MAX(hard_expires_at, ?) WHERE id = ? AND user_id = ?").bind(
          days,
          expires,
          expires,
          item.id,
          cx.user!.id,
        ),
      );
    } else {
      statements.push(
        cx.env.DB.prepare("UPDATE items SET expiry_days = ?, expires_at = ? WHERE id = ? AND user_id = ?").bind(
          days,
          // Counted from now, not from when it was saved: choosing "7 days" on an older item
          // must not delete it within the hour.
          Math.min(now() + days * DAY, item.created_at + LIMITS.item_expiry_max_days * DAY),
          item.id,
          cx.user!.id,
        ),
      );
    }
  }
  if (cx.body.dispatch_to !== undefined) {
    const target = (await listAssistants(cx.env, cx.user!.id)).find((a) => a.id === cx.body.dispatch_to);
    if (!target || target.built_in === "dispatch" || !parseJson<string[]>(target.steps, []).includes("analysis")) {
      throw err("bad_request", "只能交给助手清单里能解读的助手。", "The item can only go to an assistant in your list that may analyse.");
    }
    dispatchTo = target.id;
    statements.push(
      // Whoever held the item for analysis loses it; the new assistant picks it up on its next visit.
      cx.env.DB.prepare(
        `UPDATE items SET dispatch_to = ?1,
           analysis_attempts = CASE WHEN dispatch_to IS NOT ?1 THEN 0 ELSE analysis_attempts END,
           claim_id = CASE WHEN triaged_at IS NOT NULL AND analysed_at IS NULL AND dispatch_to IS NOT ?1 THEN NULL ELSE claim_id END,
           claim_expires_at = CASE WHEN triaged_at IS NOT NULL AND analysed_at IS NULL AND dispatch_to IS NOT ?1 THEN NULL ELSE claim_expires_at END
         WHERE id = ?2 AND user_id = ?3`,
      ).bind(target.id, item.id, cx.user!.id),
    );
  }
  if (statements.length > 0) {
    statements.push(...userSetStatements(cx.env, cx.user!.id, item.id, days, dispatchTo));
    await cx.env.DB.batch(statements);
  }
  return ok(await detail(cx, item.id));
};

/** Statements that remove an item and everything that hangs on it. */
export function purgeItemStatements(env: Env, userId: string, itemId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM analyses WHERE user_id = ? AND item_id = ?").bind(userId, itemId),
    env.DB.prepare("DELETE FROM item_tags WHERE user_id = ? AND item_id = ?").bind(userId, itemId),
    env.DB.prepare("DELETE FROM deep_read_queue WHERE user_id = ? AND item_id = ?").bind(userId, itemId),
    env.DB.prepare("DELETE FROM deep_dive_requests WHERE user_id = ? AND item_id = ?").bind(userId, itemId),
    env.DB.prepare("DELETE FROM submissions WHERE user_id = ? AND ref = ? AND kind <> 'digest'").bind(userId, itemId),
    env.DB.prepare("DELETE FROM items WHERE user_id = ? AND id = ?").bind(userId, itemId),
  ];
}

/** Deleting takes effect at once and cannot be undone. */
export const deleteItem: Handler = async (cx) => {
  const item = await liveItem(cx.env, cx.user!.id, cx.path.id);
  if (!item) throw err("not_found");
  if ((cx.env.DELETE_COPIES_ON_USER_DELETE ?? "true") !== "false") {
    const statements = purgeItemStatements(cx.env, cx.user!.id, item.id);
    if (item.asset_id) statements.push(refStatement(cx.env, cx.user!.id, item.asset_id, -1));
    await cx.env.DB.batch(statements);
    if (item.asset_id) await deleteIfUnreferenced(cx.env, cx.user!.id, item.asset_id);
  } else {
    // The copy is kept out of sight and cleaned up later by archive_retention_days.
    await cx.env.DB.batch([
      cx.env.DB.prepare("UPDATE items SET archived_at = ?, queue_holds = 0, claim_id = NULL, claim_expires_at = NULL WHERE id = ? AND user_id = ?").bind(now(), item.id, cx.user!.id),
      cx.env.DB.prepare("DELETE FROM deep_read_queue WHERE user_id = ? AND item_id = ?").bind(cx.user!.id, item.id),
      cx.env.DB.prepare("DELETE FROM deep_dive_requests WHERE user_id = ? AND item_id = ?").bind(cx.user!.id, item.id),
    ]);
  }
  return NO_CONTENT;
};

async function mustExist(cx: Cx): Promise<ItemRow> {
  const item = await liveItem(cx.env, cx.user!.id, cx.path.id);
  if (!item) throw err("not_found");
  return item;
}

export const pinItem: Handler = async (cx) => {
  const item = await mustExist(cx);
  // Keeping is the user's own decision about retention: a later triage does not change the term
  // the item returns to when it gets an end date again.
  await cx.env.DB.batch([
    cx.env.DB.prepare("UPDATE items SET pinned = 1 WHERE id = ? AND user_id = ?").bind(item.id, cx.user!.id),
    userTag(cx.env, cx.user!.id, item.id, "expiry", String(item.expiry_days)),
  ]);
  return NO_CONTENT;
};

/** The item gets an expiry again: a fresh term of its own length, counted from now. */
export const unpinItem: Handler = async (cx) => {
  const item = await mustExist(cx);
  if (item.pinned) {
    const expires = now() + item.expiry_days * DAY;
    await cx.env.DB.batch([
      cx.env.DB.prepare("UPDATE items SET pinned = 0, expires_at = ?, hard_expires_at = MAX(hard_expires_at, ?) WHERE id = ? AND user_id = ?").bind(expires, expires, item.id, cx.user!.id),
      userTag(cx.env, cx.user!.id, item.id, "expiry", String(item.expiry_days)),
    ]);
  }
  return NO_CONTENT;
};

export const setSignal: Handler = async (cx) => {
  const item = await mustExist(cx);
  await cx.env.DB.prepare("UPDATE items SET signal = ? WHERE id = ? AND user_id = ?").bind(cx.body.signal, item.id, cx.user!.id).run();
  return NO_CONTENT;
};

export const clearSignal: Handler = async (cx) => {
  const item = await mustExist(cx);
  await cx.env.DB.prepare("UPDATE items SET signal = NULL WHERE id = ? AND user_id = ?").bind(item.id, cx.user!.id).run();
  return NO_CONTENT;
};
