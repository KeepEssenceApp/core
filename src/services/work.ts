// The assistant contract: work, claims, rules, contexts, results. External assistants reach
// these functions through REST and through the assistant endpoint; the built-in assistants call
// the very same functions with their own identity. There is no other way in.
import { DAY, MINUTE, now } from "../clock";
import { LIMITS, type Env } from "../env";
import { ApiError, err, type Lang } from "../errors";
import { addDays, localDay, localToUtc } from "../time";
import type { AssistantActor, AssistantRow, ItemRow, Step, UserRow, WorkKind } from "../types";
import { iso, newId, parseJson, truncate } from "../util";
import { getUser, listAssistants } from "./accounts";
import { signedDownloadUrl } from "./assets";
import { coveredItems, coversOf, digestDay, digestDue, type DigestRow } from "./digests";
import { countStatement, displayTitle, fileOfItem, liveItem, maxExpiryDays, namesOf, OPENING_CHARS, sharedText, signature } from "./items";
import { notifyEventStatement } from "./notify";

export const WORK_KINDS: WorkKind[] = ["triage", "analysis", "digest", "deep_read"];

const TRIAGE_WHERE = "triaged_at IS NULL AND archived_at IS NULL AND fetch_state <> 'pending'";
const ANALYSIS_WHERE = "triaged_at IS NOT NULL AND analysed_at IS NULL AND archived_at IS NULL AND fetch_state <> 'pending'";
const FREE = "(claim_id IS NULL OR claim_expires_at <= ?)";

export function requireStep(actor: AssistantActor, ...anyOf: Step[]): void {
  if (!anyOf.some((s) => actor.steps.includes(s))) {
    throw err(
      "forbidden",
      `这只助手没有被允许做这一步（需要：${anyOf.join("、")}）。`,
      `This assistant is not allowed to do this step (needs: ${anyOf.join(" or ")}).`,
    );
  }
}

function claimTtl(): number {
  return LIMITS.claim_minutes * MINUTE;
}

async function capUsed(env: Env, user: UserRow, kind: string): Promise<number> {
  const row = await env.DB.prepare("SELECT n FROM daily_caps WHERE user_id = ? AND day = ? AND kind = ?")
    .bind(user.id, localDay(now(), user.timezone), kind)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export function capStatement(env: Env, user: UserRow, kind: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO daily_caps (user_id, day, kind, n) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, day, kind) DO UPDATE SET n = n + 1",
  ).bind(user.id, localDay(now(), user.timezone), kind);
}

export async function capLeft(env: Env, user: UserRow, kind: string, max: number): Promise<number> {
  return Math.max(0, max - (await capUsed(env, user, kind)));
}

// ---------------------------------------------------------------- work

export async function listWork(env: Env, actor: AssistantActor) {
  const user = await getUser(env, actor.userId);
  const t = now();
  const work: { kind: WorkKind; count: number; oldest_due_at: string | null }[] = [];
  if (actor.steps.includes("triage")) {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM items WHERE user_id = ? AND ${TRIAGE_WHERE} AND ${FREE}`)
      .bind(user.id, t)
      .first<{ n: number; oldest: number | null }>();
    if (row && row.n > 0) {
      work.push({ kind: "triage", count: row.n, oldest_due_at: iso(row.oldest! + LIMITS.triage_default_after_minutes * MINUTE) });
    }
  }
  if (actor.steps.includes("analysis")) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(expires_at) AS oldest FROM items WHERE user_id = ? AND dispatch_to = ? AND ${ANALYSIS_WHERE} AND ${FREE}`,
    )
      .bind(user.id, actor.assistantId, t)
      .first<{ n: number; oldest: number | null }>();
    if (row && row.n > 0) work.push({ kind: "analysis", count: row.n, oldest_due_at: iso(row.oldest) });
  }
  if (actor.steps.includes("digest") && user.role_digest === actor.assistantId) {
    const due = await digestDue(env, user);
    if (due) {
      const held = await env.DB.prepare("SELECT claim_expires_at FROM digests WHERE user_id = ? AND day = ? AND claim_id IS NOT NULL")
        .bind(user.id, due.day)
        .first<{ claim_expires_at: number }>();
      if (!held || held.claim_expires_at <= t) work.push({ kind: "digest", count: 1, oldest_due_at: iso(due.dueAt) });
    }
  }
  if (actor.steps.includes("deep_read") && user.role_deep_read === actor.assistantId) {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n, MIN(q.last_activity_at) AS oldest FROM deep_read_queue q
       JOIN items i ON i.id = q.item_id AND i.user_id = q.user_id
       WHERE q.user_id = ? AND q.status = 'waiting' AND i.archived_at IS NULL AND (q.claim_id IS NULL OR q.claim_expires_at <= ?)`,
    )
      .bind(user.id, t)
      .first<{ n: number; oldest: number | null }>();
    if (row && row.n > 0) work.push({ kind: "deep_read", count: row.n, oldest_due_at: iso(row.oldest! + LIMITS.queue_idle_days * DAY) });
  }
  return { work };
}

// ---------------------------------------------------------------- claims

interface ClaimRow {
  id: string;
  user_id: string;
  assistant_id: string;
  kind: WorkKind;
  refs: string;
  expires_at: number;
  status: string;
  created_at: number;
}

function emptyClaim(kind: WorkKind) {
  return { claim_id: null, kind, expires_at: null, work: [] as { ref: string; title?: string }[] };
}

/**
 * Claims up to 10 pieces of work of one kind. The write is one conditional UPDATE, so a piece
 * goes to exactly one claim even when two assistants ask at the same moment.
 */
export async function claimWork(env: Env, actor: AssistantActor, kind: WorkKind, limit = LIMITS.claim_max_items) {
  requireStep(actor, kind);
  const user = await getUser(env, actor.userId);
  const t = now();
  const claimId = newId("clm");
  const expires = t + claimTtl();
  let n = Math.min(Math.max(1, Math.floor(limit)), LIMITS.claim_max_items);
  let work: { ref: string; title?: string }[] = [];

  if (kind === "triage" || kind === "analysis") {
    if (kind === "triage") {
      const left = await capLeft(env, user, "triage", LIMITS.triage_per_user_per_day);
      if (left === 0) {
        // Over the daily cap: the core gives the waiting items their defaults itself.
        await applyTriageDefaults(env, user, 0);
        return emptyClaim(kind);
      }
      n = Math.min(n, left);
    }
    const where = kind === "triage" ? `user_id = ?3 AND ${TRIAGE_WHERE}` : `user_id = ?3 AND dispatch_to = ?6 AND ${ANALYSIS_WHERE}`;
    const sql = `UPDATE items SET claim_id = ?1, claim_expires_at = ?2
       WHERE id IN (SELECT id FROM items WHERE ${where} AND (claim_id IS NULL OR claim_expires_at <= ?4) ORDER BY created_at LIMIT ?5)
       RETURNING id, title, kind, content_unavailable`;
    const stmt =
      kind === "triage"
        ? env.DB.prepare(sql).bind(claimId, expires, user.id, t, n)
        : env.DB.prepare(sql).bind(claimId, expires, user.id, t, n, actor.assistantId);
    const rows = await stmt.all<{ id: string; title: string; kind: string; content_unavailable: number }>();
    work = rows.results.map((r) => ({ ref: r.id, title: displayTitle(r, user.lang) }));
  } else if (kind === "digest") {
    if (user.role_digest !== actor.assistantId) return emptyClaim(kind);
    const due = await digestDue(env, user);
    if (!due) return emptyClaim(kind);
    const [, claimed] = await env.DB.batch<{ day: string }>([
      env.DB.prepare("INSERT OR IGNORE INTO digests (user_id, day, status, due_at) VALUES (?, ?, 'due', ?)").bind(user.id, due.day, due.dueAt),
      env.DB.prepare(
        `UPDATE digests SET claim_id = ?, claim_expires_at = ? WHERE user_id = ? AND day = ? AND status = 'due'
         AND (claim_id IS NULL OR claim_expires_at <= ?) RETURNING day`,
      ).bind(claimId, expires, user.id, due.day, t),
    ]);
    work = claimed.results.map((r) => ({ ref: r.day, title: r.day }));
  } else {
    if (user.role_deep_read !== actor.assistantId) return emptyClaim(kind);
    const rows = await env.DB.prepare(
      `UPDATE deep_read_queue SET claim_id = ?1, claim_expires_at = ?2, last_activity_at = ?4
       WHERE item_id IN (
         SELECT q.item_id FROM deep_read_queue q JOIN items i ON i.id = q.item_id AND i.user_id = q.user_id
         WHERE q.user_id = ?3 AND q.status = 'waiting' AND i.archived_at IS NULL AND (q.claim_id IS NULL OR q.claim_expires_at <= ?4)
         ORDER BY q.added_at LIMIT ?5)
       RETURNING item_id`,
    )
      .bind(claimId, expires, user.id, t, n)
      .all<{ item_id: string }>();
    if (rows.results.length > 0) {
      const ids = rows.results.map((r) => r.item_id);
      const titles = await env.DB.prepare(
        `SELECT id, title, kind, content_unavailable FROM items WHERE user_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(user.id, ...ids)
        .all<{ id: string; title: string; kind: string; content_unavailable: number }>();
      const byId = new Map(titles.results.map((r) => [r.id, displayTitle(r, user.lang)]));
      work = ids.map((id) => ({ ref: id, title: byId.get(id) ?? "" }));
    }
  }

  if (work.length === 0) return emptyClaim(kind);
  await env.DB.prepare("INSERT INTO claims (id, user_id, assistant_id, kind, refs, expires_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)")
    .bind(claimId, user.id, actor.assistantId, kind, JSON.stringify(work.map((w) => w.ref)), expires, t)
    .run();
  return { claim_id: claimId, kind, expires_at: iso(expires), work };
}

async function ownClaim(env: Env, actor: AssistantActor, claimId: string): Promise<ClaimRow> {
  const claim = await env.DB.prepare("SELECT * FROM claims WHERE id = ? AND user_id = ? AND assistant_id = ?")
    .bind(claimId, actor.userId, actor.assistantId)
    .first<ClaimRow>();
  if (!claim) throw err("not_found");
  return claim;
}

/** Another 30 minutes. Only the holder may, and only while the claim is still alive. */
export async function renewClaim(env: Env, actor: AssistantActor, claimId: string) {
  const claim = await ownClaim(env, actor, claimId);
  const t = now();
  if (claim.status !== "active" || claim.expires_at <= t) throw err("claim_lost");
  const expires = t + claimTtl();
  await env.DB.batch([
    env.DB.prepare("UPDATE claims SET expires_at = ? WHERE id = ? AND user_id = ?").bind(expires, claim.id, actor.userId),
    env.DB.prepare("UPDATE items SET claim_expires_at = ? WHERE user_id = ? AND claim_id = ?").bind(expires, actor.userId, claim.id),
    env.DB.prepare("UPDATE digests SET claim_expires_at = ? WHERE user_id = ? AND claim_id = ?").bind(expires, actor.userId, claim.id),
    env.DB.prepare("UPDATE deep_read_queue SET claim_expires_at = ?, last_activity_at = ? WHERE user_id = ? AND claim_id = ?").bind(
      expires,
      t,
      actor.userId,
      claim.id,
    ),
  ]);
  return {
    claim_id: claim.id,
    kind: claim.kind,
    expires_at: iso(expires),
    work: parseJson<string[]>(claim.refs, []).map((ref) => ({ ref })),
  };
}

export async function releaseClaim(env: Env, actor: AssistantActor, claimId: string): Promise<void> {
  const claim = await ownClaim(env, actor, claimId);
  await env.DB.batch([
    env.DB.prepare("UPDATE items SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id = ?").bind(actor.userId, claim.id),
    env.DB.prepare("UPDATE digests SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id = ?").bind(actor.userId, claim.id),
    env.DB.prepare("UPDATE deep_read_queue SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id = ?").bind(
      actor.userId,
      claim.id,
    ),
    env.DB.prepare("UPDATE claims SET status = 'released' WHERE id = ? AND user_id = ? AND status = 'active'").bind(claim.id, actor.userId),
  ]);
}

/** A built-in assistant tries an item at most this often; then it says the content could not be read (QA #20). */
export const ANALYSIS_MAX_ATTEMPTS = 3;

/** One more failed attempt to analyse the item. Returns how many there are now. */
export async function noteAnalysisFailure(env: Env, actor: AssistantActor, itemId: string): Promise<number> {
  requireStep(actor, "analysis");
  const row = await env.DB.prepare(
    "UPDATE items SET analysis_attempts = analysis_attempts + 1 WHERE id = ? AND user_id = ? AND dispatch_to = ? AND analysed_at IS NULL RETURNING analysis_attempts",
  )
    .bind(itemId, actor.userId, actor.assistantId)
    .first<{ analysis_attempts: number }>();
  return row?.analysis_attempts ?? 0;
}

// ---------------------------------------------------------------- triage tags

/**
 * Statements that finish triage for one item: who analyses it and how long it is kept.
 * A tag the user edited is never overwritten.
 */
export function triageStatements(
  env: Env,
  item: Pick<ItemRow, "id" | "user_id" | "created_at" | "dispatch_to" | "expiry_days">,
  userTags: Set<string>,
  dispatchTo: string | null,
  expiryDays: number,
  setBy: "triage" | "core",
): D1PreparedStatement[] {
  const finalDispatch = userTags.has("assistant") ? item.dispatch_to : dispatchTo;
  const finalDays = userTags.has("expiry") ? item.expiry_days : maxExpiryDays(expiryDays);
  const upsert = (kind: string, value: string) =>
    env.DB.prepare(
      `INSERT INTO item_tags (item_id, user_id, kind, value, set_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id, kind) DO UPDATE SET value = excluded.value, set_by = excluded.set_by WHERE item_tags.set_by <> 'user'`,
    ).bind(item.id, item.user_id, kind, value, setBy);
  const out = [
    env.DB.prepare(
      `UPDATE items SET dispatch_to = ?, expiry_days = ?, expires_at = ?, triaged_at = ?, claim_id = NULL, claim_expires_at = NULL
       WHERE id = ? AND user_id = ? AND triaged_at IS NULL`,
    ).bind(finalDispatch, finalDays, item.created_at + finalDays * DAY, now(), item.id, item.user_id),
    upsert("expiry", String(finalDays)),
  ];
  if (finalDispatch) out.push(upsert("assistant", finalDispatch));
  return out;
}

async function userTagsOf(env: Env, userId: string, itemIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (itemIds.length === 0) return map;
  const rows = await env.DB.prepare(
    `SELECT item_id, kind FROM item_tags WHERE user_id = ? AND set_by = 'user' AND item_id IN (${itemIds.map(() => "?").join(",")})`,
  )
    .bind(userId, ...itemIds)
    .all<{ item_id: string; kind: string }>();
  for (const r of rows.results) {
    if (!map.has(r.item_id)) map.set(r.item_id, new Set());
    map.get(r.item_id)!.add(r.kind);
  }
  return map;
}

/**
 * The core's own triage: items that waited longer than `olderThanMs` (0: all waiting items of
 * the user) get the default assistant and 30 days. Never notifies.
 */
export async function applyTriageDefaults(env: Env, user: UserRow, olderThanMs: number): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, created_at, dispatch_to, expiry_days FROM items
     WHERE user_id = ? AND triaged_at IS NULL AND archived_at IS NULL AND created_at <= ? LIMIT 40`,
  )
    .bind(user.id, now() - olderThanMs)
    .all<Pick<ItemRow, "id" | "user_id" | "created_at" | "dispatch_to" | "expiry_days">>();
  if (rows.results.length === 0) return 0;
  const tags = await userTagsOf(env, user.id, rows.results.map((r) => r.id));
  const statements = rows.results.flatMap((item) =>
    triageStatements(env, item, tags.get(item.id) ?? new Set(), user.role_analysis, LIMITS.item_expiry_default_days, "core"),
  );
  await env.DB.batch(statements);
  return rows.results.length;
}

// ---------------------------------------------------------------- submit

export interface UsageInput {
  model?: string;
  input_tokens?: number;
  output_tokens?: number;
  calls?: number;
}

function invalid(ref: string, zh: string, en: string): ApiError {
  return err("invalid_result", `${ref}：${zh}`, `${ref}: ${en}`);
}

const REASONS = {
  not_in_claim: { zh: "不在这次认领里", en: "not part of this claim" },
  other_claim: { zh: "另一次认领已经交回了这一份", en: "another claim already handed this piece in" },
  gone: { zh: "条目已经不在了", en: "the item is no longer there" },
  triaged: { zh: "已经初筛过了", en: "already triaged" },
  not_yours: { zh: "这一条现在不归这只助手", en: "this piece is not addressed to this assistant any more" },
  not_due: { zh: "这一天没有待写的每日摘要", en: "no digest is waiting for this day" },
  not_queued: { zh: "这一条已经不在队列里", en: "the item is no longer in the queue" },
} as const;

/**
 * Hands results back for a claim. Format problems refuse the whole request (invalid_result) and
 * nothing is stored. Otherwise each result gets an outcome. Handing the same piece in twice
 * returns the first outcome and stores nothing new.
 */
export async function submitResults(env: Env, actor: AssistantActor, claimId: string, results: any[], usage: UsageInput | undefined, lang: Lang) {
  const claim = await ownClaim(env, actor, claimId);
  requireStep(actor, claim.kind);
  const user = await getUser(env, actor.userId);
  const refs = new Set(parseJson<string[]>(claim.refs, []));
  const t = now();
  const seen = new Set<string>();
  const refOf = (r: any): string => (r.kind === "digest" ? r.day : r.item_id);
  for (const r of results) {
    const ref = refOf(r);
    if (r.kind !== claim.kind) {
      throw invalid(ref, `这次认领的是 ${claim.kind}，交回的却是 ${r.kind}`, `the claim is for ${claim.kind} but the result is ${r.kind}`);
    }
    if (seen.has(ref)) throw invalid(ref, "同一份在这次交回里出现了两次", "appears twice in this submission");
    seen.add(ref);
  }
  const allRefs = [...seen];
  const prior = await env.DB.prepare(
    `SELECT ref, claim_id FROM submissions WHERE user_id = ? AND kind = ? AND ref IN (${allRefs.map(() => "?").join(",")})`,
  )
    .bind(user.id, claim.kind, ...allRefs)
    .all<{ ref: string; claim_id: string }>();
  const priorBy = new Map(prior.results.map((p) => [p.ref, p.claim_id]));

  const outcomes: { ref: string; accepted: boolean; reason?: string }[] = [];
  const statements: D1PreparedStatement[] = [];
  const refuse = (ref: string, why: keyof typeof REASONS) => outcomes.push({ ref, accepted: false, reason: REASONS[why][lang] });
  const accept = (ref: string) => {
    outcomes.push({ ref, accepted: true });
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO submissions (user_id, kind, ref, claim_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(
        user.id,
        claim.kind,
        ref,
        claim.id,
        t,
      ),
    );
  };

  const pending = results.filter((r) => {
    const ref = refOf(r);
    if (!refs.has(ref)) return refuse(ref, "not_in_claim"), false;
    const by = priorBy.get(ref);
    if (by === claim.id) return outcomes.push({ ref, accepted: true }), false; // same piece again: first outcome stands
    if (by) return refuse(ref, "other_claim"), false;
    return true;
  });

  if (claim.kind === "triage" || claim.kind === "analysis") {
    const ids = pending.map((r) => r.item_id as string);
    const items = new Map<string, ItemRow>();
    if (ids.length > 0) {
      const rows = await env.DB.prepare(
        `SELECT * FROM items WHERE user_id = ? AND archived_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(user.id, ...ids)
        .all<ItemRow>();
      for (const row of rows.results) items.set(row.id, row);
    }
    if (claim.kind === "triage") {
      const assistants = (await listAssistants(env, user.id)).filter(
        (a) => a.built_in !== "dispatch" && parseJson<string[]>(a.steps, []).includes("analysis"),
      );
      const options = parseJson<number[]>(user.expiry_options, LIMITS.expiry_options_default);
      const tags = await userTagsOf(env, user.id, ids);
      for (const r of pending) {
        const item = items.get(r.item_id);
        if (!item) {
          refuse(r.item_id, "gone");
          continue;
        }
        if (item.triaged_at) {
          refuse(r.item_id, "triaged");
          continue;
        }
        let dispatchTo = user.role_analysis;
        if (r.assistant !== undefined) {
          const found = assistants.find((a) => a.name === r.assistant);
          if (!found) throw invalid(r.item_id, `助手清单里没有能解读的「${r.assistant}」`, `no assistant named "${r.assistant}" can analyse in the user's list`);
          dispatchTo = found.id;
        }
        if (r.expiry_days !== undefined && !options.includes(r.expiry_days)) {
          throw invalid(r.item_id, `寿命只能是 ${options.join("、")} 之一`, `expiry_days must be one of ${options.join(", ")}`);
        }
        statements.push(
          ...triageStatements(env, item, tags.get(item.id) ?? new Set(), dispatchTo, r.expiry_days ?? LIMITS.item_expiry_default_days, "triage"),
          capStatement(env, user, "triage"),
        );
        accept(r.item_id);
      }
    } else {
      for (const r of pending) {
        const item = items.get(r.item_id);
        if (!item) {
          refuse(r.item_id, "gone");
          continue;
        }
        if (item.dispatch_to !== actor.assistantId) {
          refuse(r.item_id, "not_yours");
          continue;
        }
        const a = checkAnalysis(r, item);
        statements.push(
          env.DB.prepare(
            `INSERT OR REPLACE INTO analyses (item_id, user_id, unavailable, summary, key_fact, points, verdict, related_hint, assistant_id, claim_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(item.id, user.id, a.unavailable ? 1 : 0, a.summary, a.key_fact, JSON.stringify(a.points), a.verdict, a.related_hint, actor.assistantId, claim.id, t),
          env.DB.prepare("UPDATE items SET analysed_at = ?, claim_id = NULL, claim_expires_at = NULL WHERE id = ? AND user_id = ?").bind(t, item.id, user.id),
        );
        // The day's count is of items analysed, not of hand-ins: a second analysis of the same
        // item (another claim replacing the first) is not counted again.
        if (!item.analysed_at) statements.push(countStatement(env, user, "analysed"));
        if (actor.builtIn) {
          statements.push(capStatement(env, user, "analysis"));
          if (user.notify) statements.push(notifyEventStatement(env, user.id, item.id, "analysis"));
        }
        accept(item.id);
      }
    }
  } else if (claim.kind === "digest") {
    for (const r of pending) {
      const row = await env.DB.prepare("SELECT status FROM digests WHERE user_id = ? AND day = ?").bind(user.id, r.day).first<{ status: string }>();
      if (!row || row.status !== "due") {
        refuse(r.day, "not_due");
        continue;
      }
      const covered = await coveredItems(env, user, localToUtc(addDays(r.day, 1), 0, user.timezone));
      const byId = new Map(covered.map((c) => [c.id, c]));
      const worth: { item_id: string; line: string }[] = r.worth ?? [];
      const lines = new Set<string>();
      for (const w of worth) {
        if (!byId.has(w.item_id)) throw invalid(r.day, `worth 里的 ${w.item_id} 不在这份每日摘要要汇总的条目里`, `worth names ${w.item_id}, which is not among the items this digest covers`);
        if (lines.has(w.item_id)) throw invalid(r.day, `worth 里 ${w.item_id} 出现了两次`, `worth names ${w.item_id} twice`);
        lines.add(w.item_id);
      }
      if (!r.summary.trim() || !r.question.trim()) throw invalid(r.day, "总结和睡前一问不能为空", "summary and question must not be empty");
      const entries = covered.map((c) => ({ item_id: c.id, title: displayTitle(c, user.lang), verdict: c.verdict }));
      statements.push(
        env.DB.prepare(
          `UPDATE digests SET status = 'done', summary = ?, question = ?, worth = ?, entries = ?, covers = ?, assistant_id = ?, created_at = ?,
             claim_id = NULL, claim_expires_at = NULL
           WHERE user_id = ? AND day = ? AND status = 'due'`,
        ).bind(r.summary, r.question, JSON.stringify(worth), JSON.stringify(entries), JSON.stringify(coversOf(covered, user, r.day)), actor.assistantId, t, user.id, r.day),
        countStatement(env, user, "digests"),
      );
      const ids = covered.map((c) => c.id);
      for (let i = 0; i < ids.length; i += 80) {
        const chunk = ids.slice(i, i + 80);
        statements.push(
          env.DB.prepare(`UPDATE items SET digest_day = ? WHERE user_id = ? AND digest_day IS NULL AND id IN (${chunk.map(() => "?").join(",")})`).bind(
            r.day,
            user.id,
            ...chunk,
          ),
        );
      }
      if (actor.builtIn) statements.push(capStatement(env, user, "digest"));
      accept(r.day);
    }
  } else {
    for (const r of pending) {
      const row = await env.DB.prepare(
        `SELECT q.item_id FROM deep_read_queue q JOIN items i ON i.id = q.item_id AND i.user_id = q.user_id
         WHERE q.user_id = ? AND q.item_id = ? AND i.archived_at IS NULL`,
      )
        .bind(user.id, r.item_id)
        .first();
      if (!row) {
        refuse(r.item_id, "not_queued");
        continue;
      }
      statements.push(
        env.DB.prepare(
          `UPDATE deep_read_queue SET status = 'ready', report = ?, assistant_id = ?, entry = ?, last_activity_at = ?, claim_id = NULL, claim_expires_at = NULL
           WHERE user_id = ? AND item_id = ?`,
        ).bind(JSON.stringify({ read: r.read, found: r.found, questions: r.questions }), actor.assistantId, r.entry ?? null, t, user.id, r.item_id),
      );
      if (actor.builtIn && user.notify) statements.push(notifyEventStatement(env, user.id, r.item_id, "deep_read"));
      accept(r.item_id);
    }
  }

  const accepted = outcomes.filter((o) => o.accepted).length;
  // Every hand-in is recorded. Built-in assistants are measured by the core; the others report themselves.
  statements.push(
    env.DB.prepare(
      `INSERT INTO usage_records (id, user_id, assistant_id, claim_id, kind, model, input_tokens, output_tokens, calls, items, self_reported, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(newId("use"), user.id, actor.assistantId, claim.id, claim.kind, usage?.model ?? null, usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, usage?.calls ?? 0, accepted, actor.builtIn ? 0 : 1, t),
    env.DB.prepare(
      `UPDATE claims SET status = 'done' WHERE id = ?1 AND user_id = ?2 AND status = 'active'
       AND (SELECT COUNT(*) FROM submissions WHERE user_id = ?2 AND claim_id = ?1) >= ?3`,
    ).bind(claim.id, user.id, refs.size),
  );
  await env.DB.batch(statements);
  // Outcomes in the order the results were sent.
  return { outcomes: results.map((r) => outcomes.find((o) => o.ref === refOf(r))!) };
}

/** The four fixed fields of an analysis, checked beyond what the schema can say. */
function checkAnalysis(r: any, item: ItemRow) {
  const points: string[] = r.points ?? [];
  if (r.unavailable === true || item.content_unavailable === 1) {
    if (r.unavailable !== true) {
      throw invalid(item.id, "这一条没取到内容，只能交回 unavailable: true", "the content of this item could not be fetched; hand back unavailable: true");
    }
    if (points.length > 0 || r.verdict !== undefined || r.key_fact !== undefined || r.related_hint !== undefined) {
      throw invalid(item.id, "没取到内容时不收要点、关键事实和判定", "when the content is unavailable, points, key_fact and verdict are not accepted");
    }
    return { unavailable: true, summary: (r.summary ?? "").trim(), key_fact: null, points: [], verdict: null, related_hint: null };
  }
  if (typeof r.summary !== "string" || !r.summary.trim()) throw invalid(item.id, "缺少内容概述 summary", "summary is required");
  if (r.verdict === undefined) throw invalid(item.id, "缺少判定 verdict", "verdict is required");
  if (points.some((p) => !p.trim())) throw invalid(item.id, "要点不能是空的", "a point must not be empty");
  return {
    unavailable: false,
    summary: r.summary.trim(),
    key_fact: (r.key_fact ?? "").trim() || null,
    points,
    verdict: r.verdict as string,
    related_hint: (r.related_hint ?? "").trim() || null,
  };
}

// ---------------------------------------------------------------- rules and contexts

export async function getRules(env: Env, actor: AssistantActor, kind: WorkKind) {
  requireStep(actor, kind);
  const user = await getUser(env, actor.userId);
  const assistants = (await listAssistants(env, user.id)).filter((a) => a.built_in !== "dispatch");
  return {
    rules: user.rules,
    preference: user.preference,
    assistants: assistants.map((a) => ({ name: a.name, steps: parseJson<string[]>(a.steps, []) })),
    default_analysis_assistant: assistants.find((a) => a.id === user.role_analysis)?.name ?? null,
    expiry_options: parseJson<number[]>(user.expiry_options, LIMITS.expiry_options_default),
    lang: user.lang,
    timezone: user.timezone,
  };
}

function analysisOf(row: any, names: Map<string, string>, lang: Lang) {
  if (!row) return null;
  const base = { assistant: signature(names, row.assistant_id), created_at: iso(row.created_at) };
  if (row.unavailable) return { unavailable: true, summary: row.summary || sharedText("content_unavailable", lang), ...base };
  const fact = row.key_fact ?? "";
  return {
    unavailable: false,
    summary: row.summary,
    key_fact: fact,
    points: parseJson<string[]>(row.points, []),
    verdict: row.verdict,
    related_hint: row.related_hint,
    ...base,
  };
}

async function relatedTo(env: Env, user: UserRow, item: ItemRow) {
  const related: { kind: "item" | "digest" | "note"; ref: string; title: string; excerpt?: string }[] = [];
  const [items, digests, notes] = await env.DB.batch<any>([
    env.DB.prepare(
      `SELECT i.id, i.title, i.kind, i.content_unavailable, a.summary FROM items i
       LEFT JOIN analyses a ON a.item_id = i.id AND a.user_id = i.user_id
       WHERE i.user_id = ? AND i.archived_at IS NULL AND i.id <> ? AND i.site IS NOT NULL AND i.site = ?
       ORDER BY i.created_at DESC LIMIT 3`,
    ).bind(user.id, item.id, item.site),
    env.DB.prepare("SELECT day, summary FROM digests WHERE user_id = ? AND status = 'done' ORDER BY day DESC LIMIT 2").bind(user.id),
    env.DB.prepare("SELECT id, title, body FROM notes WHERE user_id = ? AND (item_id = ? OR (? <> '' AND item_url = ?)) ORDER BY created_at DESC LIMIT 3").bind(
      user.id,
      item.id,
      item.url ?? "",
      item.url ?? "",
    ),
  ]);
  for (const r of items.results) related.push({ kind: "item", ref: r.id, title: displayTitle(r, user.lang), excerpt: r.summary ?? undefined });
  for (const r of digests.results) related.push({ kind: "digest", ref: r.day, title: r.day, excerpt: truncate(r.summary ?? "", 200) });
  for (const r of notes.results) related.push({ kind: "note", ref: r.id, title: r.title, excerpt: truncate(r.body, 200) });
  return related;
}

/** What an assistant needs to work on one item. Triage gets the title, the site and the opening only. */
export async function getContext(env: Env, actor: AssistantActor, itemId: string, purpose: "triage" | "analysis" | "deep_read" | "deep_dive", origin: string) {
  requireStep(actor, purpose);
  const user = await getUser(env, actor.userId);
  const item = await liveItem(env, user.id, itemId);
  if (!item) throw err("not_found");
  const title = displayTitle(item, user.lang);
  if (purpose === "triage") {
    return {
      item: { id: item.id, kind: item.kind, title, site: item.site, opening: truncate(item.opening, OPENING_CHARS), content_unavailable: item.content_unavailable === 1, saved_at: iso(item.created_at) },
      related: [],
    };
  }
  const queue = await env.DB.prepare("SELECT * FROM deep_read_queue WHERE user_id = ? AND item_id = ?").bind(user.id, item.id).first<any>();
  if (purpose === "analysis" && item.dispatch_to !== actor.assistantId) {
    throw err("forbidden", "这一条不归这只助手解读。", "This item is not addressed to this assistant for analysis.");
  }
  if (purpose === "deep_read" && (user.role_deep_read !== actor.assistantId || !queue)) {
    throw err("forbidden", "这一条不归这只助手精读。", "This item is not addressed to this assistant for a deep read.");
  }
  const names = namesOf(await listAssistants(env, user.id, true));
  // A text file's content is the body; an older item gets it now. Images and PDFs are handed out as an address.
  const file = await fileOfItem(env, item);
  const analysis = await env.DB.prepare("SELECT * FROM analyses WHERE item_id = ? AND user_id = ?").bind(item.id, user.id).first<any>();
  if (queue && (purpose === "deep_read" || purpose === "deep_dive")) {
    const t = now();
    await env.DB.prepare("UPDATE deep_read_queue SET fetched_at = ?, last_activity_at = ? WHERE user_id = ? AND item_id = ?").bind(t, t, user.id, item.id).run();
  }
  const report = queue?.report ? parseJson<any>(queue.report, null) : null;
  return {
    item: {
      id: item.id,
      kind: item.kind,
      title,
      site: item.site,
      url: item.url,
      opening: truncate(item.opening, OPENING_CHARS),
      body: item.body,
      content_unavailable: item.content_unavailable === 1,
      asset_url: item.asset_id ? await signedDownloadUrl(env, origin, user.id, item.asset_id) : null,
      asset_type: file.type,
      saved_at: iso(item.created_at),
    },
    analysis: analysisOf(analysis, names, user.lang),
    deep_read: report ? { ...report, assistant: signature(names, queue.assistant_id) } : null,
    related: await relatedTo(env, user, item),
  };
}

export async function getDigestContext(env: Env, actor: AssistantActor, dayParam: string) {
  requireStep(actor, "digest");
  const user = await getUser(env, actor.userId);
  if (user.role_digest !== actor.assistantId) {
    throw err("forbidden", "每日摘要不归这只助手写。", "This assistant is not the one that writes the daily digest.");
  }
  const day = dayParam === "latest" ? digestDay(user).day : dayParam;
  const covered = await coveredItems(env, user, localToUtc(addDays(day, 1), 0, user.timezone));
  return {
    day,
    covers: coversOf(covered, user, day),
    analyses: covered.map((c) => ({
      item_id: c.id,
      title: displayTitle(c, user.lang),
      site: c.site,
      url: c.url,
      summary: c.unavailable ? c.summary || sharedText("content_unavailable", user.lang) : c.summary,
      ...(c.unavailable ? {} : { key_fact: c.key_fact ?? "", points: parseJson<string[]>(c.points, []), verdict: c.verdict }),
      unavailable: c.unavailable === 1,
      signal: c.signal,
      in_queue: c.in_queue > 0,
    })),
  };
}

function excerptAround(text: string, q: string, span = 160): string {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, (at < 0 ? 0 : at) - 40);
  return (start > 0 ? "…" : "") + text.slice(start, start + span).replace(/\s+/g, " ").trim();
}

export function likePattern(q: string): string {
  return "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/** Text lookup in the user's daily digests and notes: context for work, not a user feature. */
export async function searchDigestsAndNotes(env: Env, actor: AssistantActor, q: string, limit = 20) {
  requireStep(actor, "analysis", "digest", "deep_read");
  const like = likePattern(q);
  const [digests, notes] = await env.DB.batch<any>([
    env.DB.prepare(
      `SELECT day, summary, question, worth FROM digests WHERE user_id = ? AND status = 'done'
       AND (summary LIKE ? ESCAPE '\\' OR question LIKE ? ESCAPE '\\' OR worth LIKE ? ESCAPE '\\') ORDER BY day DESC LIMIT ?`,
    ).bind(actor.userId, like, like, like, limit),
    env.DB.prepare(
      `SELECT id, title, body FROM notes WHERE user_id = ? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`,
    ).bind(actor.userId, like, like, limit),
  ]);
  const matches: { kind: "digest" | "note"; ref: string; title: string; excerpt: string }[] = [];
  for (const d of digests.results) {
    const lines = parseJson<{ line: string }[]>(d.worth, []).map((w) => w.line);
    matches.push({ kind: "digest", ref: d.day, title: d.day, excerpt: excerptAround([d.summary, ...lines, d.question].join(" "), q) });
  }
  for (const n of notes.results) matches.push({ kind: "note", ref: n.id, title: n.title, excerpt: excerptAround(n.body, q) });
  return { matches: matches.slice(0, limit) };
}

// ---------------------------------------------------------------- deep dive

/** What the user could dig into now: the queue, the latest digest's worth list, today's analyses. */
export async function listDeepDiveCandidates(env: Env, actor: AssistantActor, q?: string) {
  requireStep(actor, "deep_dive");
  const user = await getUser(env, actor.userId);
  const out = new Map<string, { item_id: string; title: string; summary?: string; from: "queue" | "digest" | "today"; deep_read_ready?: boolean }>();
  const [queue, digest, today] = await env.DB.batch<any>([
    env.DB.prepare(
      `SELECT i.id, i.title, i.kind, i.content_unavailable, a.summary, q.status FROM deep_read_queue q
       JOIN items i ON i.id = q.item_id AND i.user_id = q.user_id
       LEFT JOIN analyses a ON a.item_id = i.id AND a.user_id = i.user_id
       WHERE q.user_id = ? AND i.archived_at IS NULL ORDER BY q.added_at DESC LIMIT 50`,
    ).bind(user.id),
    env.DB.prepare("SELECT worth FROM digests WHERE user_id = ? AND status = 'done' ORDER BY day DESC LIMIT 1").bind(user.id),
    env.DB.prepare(
      `SELECT i.id, i.title, i.kind, i.content_unavailable, a.summary FROM items i
       JOIN analyses a ON a.item_id = i.id AND a.user_id = i.user_id
       WHERE i.user_id = ? AND i.archived_at IS NULL AND i.digest_day IS NULL AND a.unavailable = 0 ORDER BY i.analysed_at DESC LIMIT 30`,
    ).bind(user.id),
  ]);
  for (const r of queue.results) {
    out.set(r.id, { item_id: r.id, title: displayTitle(r, user.lang), summary: r.summary ?? undefined, from: "queue", deep_read_ready: r.status === "ready" });
  }
  const worth = parseJson<{ item_id: string; line: string }[]>(digest.results[0]?.worth, []).filter((w) => !out.has(w.item_id));
  if (worth.length > 0) {
    const ids = worth.slice(0, 50).map((w) => w.item_id);
    const rows = await env.DB.prepare(
      `SELECT id, title, kind, content_unavailable FROM items WHERE user_id = ? AND archived_at IS NULL AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(user.id, ...ids)
      .all<any>();
    const live = new Map(rows.results.map((r: any) => [r.id, r]));
    for (const w of worth) {
      const r = live.get(w.item_id);
      if (r) out.set(r.id, { item_id: r.id, title: displayTitle(r, user.lang), summary: w.line, from: "digest", deep_read_ready: false });
    }
  }
  for (const r of today.results) {
    if (!out.has(r.id)) out.set(r.id, { item_id: r.id, title: displayTitle(r, user.lang), summary: r.summary ?? undefined, from: "today", deep_read_ready: false });
  }
  let candidates = [...out.values()];
  if (q && q.trim()) {
    const needle = q.trim().toLowerCase();
    candidates = candidates.filter((c) => c.title.toLowerCase().includes(needle) || (c.summary ?? "").toLowerCase().includes(needle));
  }
  return { candidates };
}

export function openingLine(title: string, lang: Lang): string {
  return sharedText("opening_line", lang).replace("{first_line}", title);
}

/** Records that a deep dive on one item started with an assistant (or continues one started in the product). */
export async function recordDeepDive(env: Env, user: UserRow, item: ItemRow, assistantId: string): Promise<string> {
  const t = now();
  const line = openingLine(displayTitle(item, user.lang), user.lang);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO deep_dive_requests (id, user_id, item_id, assistant_id, opening_line, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, item_id, assistant_id) DO UPDATE SET last_activity_at = excluded.last_activity_at`,
    ).bind(newId("ddr"), user.id, item.id, assistantId, line, t, t),
    env.DB.prepare("UPDATE deep_read_queue SET last_activity_at = ? WHERE user_id = ? AND item_id = ?").bind(t, user.id, item.id),
  ]);
  return line;
}

export async function registerDeepDive(env: Env, actor: AssistantActor, itemId: string) {
  requireStep(actor, "deep_dive");
  const user = await getUser(env, actor.userId);
  const item = await liveItem(env, user.id, itemId);
  if (!item) throw err("not_found");
  await recordDeepDive(env, user, item, actor.assistantId);
  return { item_id: item.id };
}
