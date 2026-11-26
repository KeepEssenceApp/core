// The account itself, for its owner: one document with everything that lasts, and deleting it.
import { now } from "../clock";
import type { Lang } from "../errors";
import { err } from "../errors";
import { localDay } from "../time";
import { NO_CONTENT, type Cx, type Handler, type UserRow } from "../types";
import { iso, parseJson } from "../util";
import { LIMITS } from "../env";
import { listAssistants } from "../services/accounts";
import { digestParts, type DigestRow } from "../services/digests";
import { ITEM_FROM, ITEM_SELECT, endsAt, itemView, namesOf, signature, type ItemJoined, type Names } from "../services/items";
import { noteView, type NoteRow } from "../services/notes";
import { deleteAccount } from "./admin";
import { normalEmail } from "./signin";

// ---------------------------------------------------------------- export

/** Rows read per statement. Items carry their whole text, so their pages are smaller. */
const PAGE = 100;
const ITEM_PAGE = 40;

const CONTENTS: Record<Lang, { included: string[]; not_included: string[]; files: string }> = {
  en: {
    included: [
      "Your settings: rules, the choices for how long items are kept, notifications, time zone, language, and which assistant does which step.",
      "Every daily digest.",
      "Every note, with its sources and the item or daily digest it came from.",
      "Every item that still exists, with its text (and, for a video, the recognized text), its analysis and its tags.",
      "A list of your files: name, type and size.",
    ],
    not_included: [
      "Items that were deleted, by you or because their time ran out.",
      "The contents of files (images, PDFs and other attachments).",
      "Devices, assistants' credentials, and counts of use.",
    ],
    files: "File contents are not in this document. Each file is downloaded separately: open the item or note it belongs to, or ask for it with GET /v1/assets/{id}.",
  },
  zh: {
    included: [
      "你的各项选择：规则、保留期限的选项、通知、时区、语言，以及哪只助手做哪一步。",
      "每一份每日摘要。",
      "每一篇笔记，连同它的出处和它来自的条目或每日摘要。",
      "每一条还在的条目，连同原文（有视频的，还有识别出来的文字）、解读和标签。",
      "你的文件清单：名称、类型和大小。",
    ],
    not_included: ["已经删除的条目，不论是你删的还是到期删的。", "文件本身的内容（图片、PDF 和其他附件）。", "设备、助手的凭据和用量数字。"],
    files: "文件的内容不在这份文档里。每个文件单独下载：打开它所属的条目或笔记，或用 GET /v1/assets/{id} 取。",
  },
};

const EXTENSION: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
};

interface ExportFile {
  id: string;
  name: string;
  type: string;
  size: number;
}

type ExportItemRow = ItemJoined & { body: string | null; recognized_text: string | null; f_bytes: number | null; f_type: string | null };

/**
 * The document, piece by piece. Each table is read a page at a time by its own key (never by
 * OFFSET), so a large account costs as many rows read as it has rows, and no page is held longer
 * than it takes to write it out.
 */
async function* exportParts(cx: Cx): AsyncGenerator<string> {
  const env = cx.env;
  const user = cx.user!;
  const assistants = await listAssistants(env, user.id, true);
  const names: Names = namesOf(assistants);
  const role = (id: string | null) => (id ? signature(names, id) : null);
  const head = {
    version: 1,
    exported_at: iso(now()),
    contents: CONTENTS[cx.lang],
    account: { id: user.id, email: user.email, created_at: iso(user.created_at) },
    settings: {
      rules: user.rules,
      expiry_options: parseJson<number[]>(user.expiry_options, LIMITS.expiry_options_default),
      notify: user.notify === 1,
      timezone: user.timezone,
      lang: user.lang,
      always_my_language: user.always_my_language === 1,
      roles: { analysis: role(user.role_analysis), digest: role(user.role_digest), deep_read: role(user.role_deep_read), deep_dive: role(user.role_deep_dive) },
      calendar_image_enabled: user.calendar_enabled === 1,
    },
  };
  // Everything but the closing brace; the lists follow as further members.
  yield JSON.stringify(head, null, 1).replace(/\n}$/, "");

  /** One list of the document: `rows(after)` gives the next page and the key to go on from. */
  async function* list<T>(name: string, page: (after: T | null) => Promise<{ out: unknown[]; next: T | null }>): AsyncGenerator<string> {
    yield `,\n "${name}": [`;
    let after: T | null = null;
    let first = true;
    for (;;) {
      const { out, next } = await page(after);
      let text = "";
      for (const o of out) {
        text += (first ? "\n  " : ",\n  ") + JSON.stringify(o);
        first = false;
      }
      if (text) yield text;
      if (next === null) break;
      after = next;
    }
    yield first ? "]" : "\n ]";
  }

  yield* list<string>("digests", async (after) => {
    const rows = await env.DB.prepare("SELECT * FROM digests WHERE user_id = ? AND status = 'done' AND day > ? ORDER BY day LIMIT ?")
      .bind(user.id, after ?? "", PAGE)
      .all<DigestRow>();
    const out = rows.results.map((d) => {
      const { worth, entries } = digestParts(d);
      return {
        day: d.day,
        read: d.read_at !== null,
        created_at: iso(d.created_at),
        covers: parseJson<string[]>(d.covers, [d.day]),
        summary: d.summary ?? "",
        question: d.question ?? "",
        worth: worth.map((w) => ({ item_id: w.item_id, line: w.line })),
        entries: entries.map((e) => ({ item_id: e.item_id, title: e.title, verdict: e.verdict ?? null })),
        assistant: signature(names, d.assistant_id),
      };
    });
    return { out, next: rows.results.length === PAGE ? rows.results[PAGE - 1].day : null };
  });

  yield* list<{ at: number; id: string }>("notes", async (after) => {
    const rows = await env.DB.prepare("SELECT * FROM notes WHERE user_id = ? AND (created_at, id) > (?, ?) ORDER BY created_at, id LIMIT ?")
      .bind(user.id, after?.at ?? -1, after?.id ?? "", PAGE)
      .all<NoteRow>();
    const last = rows.results[rows.results.length - 1];
    return { out: rows.results.map(noteView), next: rows.results.length === PAGE ? { at: last.created_at, id: last.id } : null };
  });

  // The title of the item a file was saved as is the only name the file has.
  const fileNames = new Map<string, string>();
  const fileOf = (id: string, type: string, size: number): ExportFile => ({ id, name: fileNames.get(id) || `${id}.${EXTENSION[type] ?? "bin"}`, type, size });

  yield* list<{ at: number; id: string }>("items", async (after) => {
    const at = after?.at ?? -1;
    const id = after?.id ?? "";
    const page = "SELECT id FROM items WHERE user_id = ?1 AND archived_at IS NULL AND (created_at, id) > (?2, ?3) ORDER BY created_at, id LIMIT ?4";
    const [items, tags] = await env.DB.batch<any>([
      env.DB.prepare(
        `SELECT ${ITEM_SELECT}, i.body, i.recognized_text, f.bytes AS f_bytes, f.content_type AS f_type ${ITEM_FROM}
         LEFT JOIN assets f ON f.id = i.asset_id AND f.user_id = i.user_id AND f.status = 'stored'
         WHERE i.user_id = ?1 AND i.archived_at IS NULL AND (i.created_at, i.id) > (?2, ?3) ORDER BY i.created_at, i.id LIMIT ?4`,
      ).bind(user.id, at, id, ITEM_PAGE),
      env.DB.prepare(`SELECT item_id, kind, value, set_by FROM item_tags WHERE user_id = ?1 AND item_id IN (${page}) ORDER BY item_id, kind`).bind(user.id, at, id, ITEM_PAGE),
    ]);
    const tagsOf = new Map<string, { kind: string; value: string; set_by: string }[]>();
    for (const t of tags.results as { item_id: string; kind: string; value: string; set_by: string }[]) {
      if (!tagsOf.has(t.item_id)) tagsOf.set(t.item_id, []);
      tagsOf.get(t.item_id)!.push(t);
    }
    const rows = items.results as ExportItemRow[];
    const out = rows.map((r) => {
      const view = itemView(r, names, cx.lang, (cx.user as UserRow).timezone);
      if (r.asset_id && r.f_type !== null) fileNames.set(r.asset_id, view.title);
      const setBy = (kind: string): "user" | "triage" | "default" => {
        const by = (tagsOf.get(r.id) ?? []).find((t) => t.kind === kind)?.set_by;
        return by === "user" ? "user" : by === "triage" ? "triage" : "default";
      };
      return {
        ...view,
        retention_set_by: r.pinned ? "user" : setBy("expiry"),
        assistant_set_by: setBy("assistant"),
        body: r.body,
        recognized_text: r.recognized_text ?? null,
        asset_id: r.asset_id,
        // As on the item itself: a kept item has no end date, so no expiry tag is listed.
        tags: (tagsOf.get(r.id) ?? []).filter((t) => !(r.pinned && t.kind === "expiry")).map((t) => `${t.kind}:${t.kind === "assistant" ? (names.get(t.value) ?? t.value) : t.value}`),
        expiry_days: r.pinned ? null : r.expiry_days,
        expires_at: iso(endsAt(r)),
        file: r.asset_id && r.f_type !== null ? fileOf(r.asset_id, r.f_type, r.f_bytes ?? 0) : null,
      };
    });
    const last = rows[rows.length - 1];
    return { out, next: rows.length === ITEM_PAGE ? { at: last.created_at, id: last.id } : null };
  });

  // Files that something still refers to (an item that exists, or a note). Never their bytes.
  yield* list<string>("files", async (after) => {
    const rows = await env.DB.prepare(
      "SELECT id, sha256, bytes, content_type FROM assets WHERE user_id = ? AND status = 'stored' AND refs > 0 AND sha256 > ? ORDER BY sha256 LIMIT ?",
    )
      .bind(user.id, after ?? "", PAGE)
      .all<{ id: string; sha256: string; bytes: number; content_type: string }>();
    return { out: rows.results.map((a) => fileOf(a.id, a.content_type, a.bytes)), next: rows.results.length === PAGE ? rows.results[PAGE - 1].sha256 : null };
  });

  yield "\n}\n";
}

/** `GET /v1/export`: streamed, so the document is never held whole by the core. */
export const exportData: Handler = async (cx) => {
  const parts = exportParts(cx);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await parts.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        // The status is already sent: the document just ends, and is then not valid JSON.
        console.error("export failed", e);
        controller.error(e);
      }
    },
    async cancel() {
      await parts.return(undefined);
    },
  });
  const day = localDay(now(), (cx.user as UserRow).timezone);
  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="export-${day}.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
};

// ---------------------------------------------------------------- deleting the account

/**
 * `DELETE /v1/account`: the user deletes their own account. Nothing is removed here: the one
 * deletion there is (the operator's, handlers/admin.ts) does it, and records it as the user's own.
 */
export const deleteOwnAccount: Handler = async (cx) => {
  const user = cx.user!;
  if (normalEmail(String(cx.body.confirm_email ?? "")) !== user.email) {
    throw err("bad_request", "邮箱和这个账户的邮箱不一致，没有删除。", "The email does not match the email of this account. Nothing was deleted.");
  }
  await deleteAccount(cx.env, { id: user.id, email: user.email }, "user");
  return NO_CONTENT;
};
