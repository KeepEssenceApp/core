// Scheduled work. Every minute: page fetch fallback, the core's triage defaults, the built-in
// assistants, notifications. Every hour: expiry and cleanup. Batches are small so that one run
// stays light.
import { DAY, MINUTE, now } from "./clock";
import { analyseForUser, digestForUser, dispatchForUser, modelConfigured } from "./builtin";
import { LIMITS, num, type Env } from "./env";
import { purgeItemStatements } from "./handlers/items";
import { cleanAssets, deleteIfUnreferenced, refStatement } from "./services/assets";
import { fetchItemContent } from "./services/items";
import { leaveQueueStatements } from "./services/notes";
import { sendDueNotifications } from "./services/notify";
import { applyTriageDefaults } from "./services/work";
import type { ItemRow, UserRow } from "./types";

/** Accounts the operator suspended: the cron work passes them by, so they never take a slot of a run. */
const NOT_SUSPENDED = "NOT IN (SELECT id FROM users WHERE suspended_at IS NOT NULL)";

export const CRON_KEYS = { minute: "cron.minute_ran_at", hourly: "cron.hourly_ran_at" } as const;

/** Notes when a cron job last finished; GET /admin/overview reports it. */
async function recordRun(env: Env, key: string): Promise<void> {
  const t = now();
  await env.DB.prepare("INSERT INTO core_state (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(key, String(t), t)
    .run();
}

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`cron ${name} failed`, e);
  }
}

/** Links whose content never arrived (the request that saved them ended early). */
export async function fetchFallback(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `UPDATE items SET fetch_attempts = fetch_attempts + 1
     WHERE id IN (SELECT id FROM items WHERE fetch_state = 'pending' AND archived_at IS NULL AND created_at <= ?
       AND user_id ${NOT_SUSPENDED} ORDER BY created_at LIMIT 3)
     RETURNING id, user_id, url, title, title_from, body, fetch_attempts`,
  )
    .bind(now() - MINUTE)
    .all<ItemRow>();
  for (const item of rows.results) {
    if (item.fetch_attempts > 2) {
      await env.DB.prepare(
        "UPDATE items SET fetch_state = 'failed', content_unavailable = CASE WHEN body IS NULL OR body = '' THEN 1 ELSE 0 END WHERE id = ? AND user_id = ? AND fetch_state = 'pending'",
      )
        .bind(item.id, item.user_id)
        .run();
    } else {
      await fetchItemContent(env, item);
    }
  }
}

/** Items nobody triaged within 10 minutes get the defaults from the core. */
export async function triageDefaults(env: Env): Promise<void> {
  const after = LIMITS.triage_default_after_minutes * MINUTE;
  const users = await env.DB.prepare(
    `SELECT u.* FROM users u WHERE u.suspended_at IS NULL AND u.id IN (
       SELECT DISTINCT user_id FROM items WHERE triaged_at IS NULL AND archived_at IS NULL AND created_at <= ?
       AND user_id ${NOT_SUSPENDED} LIMIT 10)`,
  )
    .bind(now() - after)
    .all<UserRow>();
  for (const user of users.results) await applyTriageDefaults(env, user, after);
}

async function runBuiltIns(env: Env, origin: string): Promise<void> {
  if (!modelConfigured(env)) return; // no model key: the built-in assistants simply do nothing
  const t = now();
  const triage = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM items WHERE triaged_at IS NULL AND archived_at IS NULL AND fetch_state <> 'pending'
     AND (claim_id IS NULL OR claim_expires_at <= ?) AND user_id ${NOT_SUSPENDED} ORDER BY created_at LIMIT ?`,
  )
    .bind(t, num(env.TRIAGE_USERS_PER_RUN, 3))
    .all<{ user_id: string }>();
  for (const row of triage.results) await step("dispatch", () => dispatchForUser(env, row.user_id));

  const analysis = await env.DB.prepare(
    `SELECT DISTINCT i.user_id FROM items i JOIN assistants a ON a.id = i.dispatch_to AND a.user_id = i.user_id
     WHERE a.built_in = 'worker' AND i.triaged_at IS NOT NULL AND i.analysed_at IS NULL AND i.archived_at IS NULL AND i.fetch_state <> 'pending'
     AND (i.claim_id IS NULL OR i.claim_expires_at <= ?) AND i.user_id ${NOT_SUSPENDED} ORDER BY i.created_at LIMIT ?`,
  )
    .bind(now(), num(env.ANALYSIS_USERS_PER_RUN, 2))
    .all<{ user_id: string }>();
  for (const row of analysis.results) await step("analysis", () => analyseForUser(env, row.user_id, origin));

  const digests = await env.DB.prepare(
    `SELECT u.* FROM users u JOIN assistants a ON a.id = u.role_digest AND a.user_id = u.id AND a.built_in = 'worker'
     WHERE u.suspended_at IS NULL
       AND u.id IN (SELECT DISTINCT user_id FROM items WHERE analysed_at IS NOT NULL AND digest_day IS NULL AND archived_at IS NULL) LIMIT 50`,
  ).all<UserRow>();
  let written = 0;
  for (const user of digests.results) {
    if (written >= 2) break;
    await step("digest", async () => {
      if (await digestForUser(env, user)) written++;
    });
  }
}

export async function runMinute(env: Env): Promise<void> {
  const origin = env.PUBLIC_ORIGIN || env.APP_ORIGIN || "";
  await step("fetch", () => fetchFallback(env));
  await step("triage-defaults", () => triageDefaults(env));
  await runBuiltIns(env, origin);
  await step("notify", () => sendDueNotifications(env));
  await step("record", () => recordRun(env, CRON_KEYS.minute));
}

/** Expiry: an item past its term is archived. Pinned items never are; queued items wait, but not past their hard limit. */
export async function expireItems(env: Env): Promise<number> {
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET archived_at = ?1, claim_id = NULL, claim_expires_at = NULL, queue_holds = 0
       WHERE archived_at IS NULL AND pinned = 0 AND ((expires_at <= ?1 AND queue_holds = 0) OR hard_expires_at <= ?1)`,
    ).bind(t),
    env.DB.prepare("DELETE FROM deep_read_queue WHERE item_id IN (SELECT id FROM items WHERE archived_at IS NOT NULL)"),
    env.DB.prepare("DELETE FROM deep_dive_requests WHERE item_id IN (SELECT id FROM items WHERE archived_at IS NOT NULL)"),
  ]);
  return res[0].meta.changes ?? 0;
}

/** archive_retention_days: empty keeps archived items; N removes them N days after they were archived. */
async function cleanArchive(env: Env): Promise<void> {
  const days = num(env.ARCHIVE_RETENTION_DAYS, 0);
  if (days <= 0) return;
  const rows = await env.DB.prepare("SELECT id, user_id, asset_id FROM items WHERE archived_at IS NOT NULL AND archived_at <= ? LIMIT 20")
    .bind(now() - days * DAY)
    .all<{ id: string; user_id: string; asset_id: string | null }>();
  for (const item of rows.results) {
    const statements = purgeItemStatements(env, item.user_id, item.id);
    if (item.asset_id) statements.push(refStatement(env, item.user_id, item.asset_id, -1));
    await env.DB.batch(statements);
    if (item.asset_id) await deleteIfUnreferenced(env, item.user_id, item.asset_id);
  }
}

/** Queue entries and deep-dive requests with no activity for 7 days go away quietly. */
export async function cleanQueue(env: Env): Promise<void> {
  const cutoff = now() - LIMITS.queue_idle_days * DAY;
  const idle = await env.DB.prepare(
    "SELECT item_id, user_id FROM deep_read_queue WHERE last_activity_at <= ? AND (claim_id IS NULL OR claim_expires_at <= ?) LIMIT 30",
  )
    .bind(cutoff, now())
    .all<{ item_id: string; user_id: string }>();
  const statements = idle.results.flatMap((q) => leaveQueueStatements(env, q.user_id, q.item_id));
  statements.push(env.DB.prepare("DELETE FROM deep_dive_requests WHERE last_activity_at <= ?").bind(cutoff));
  await env.DB.batch(statements);
}

async function cleanTables(env: Env): Promise<void> {
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM login_codes WHERE expires_at <= ?").bind(t),
    env.DB.prepare("DELETE FROM device_codes WHERE expires_at <= ?").bind(t - DAY),
    env.DB.prepare("DELETE FROM devices WHERE credential_hash IS NULL AND revoked_at IS NULL AND created_at <= ?").bind(t - DAY),
    env.DB.prepare("DELETE FROM oauth_requests WHERE expires_at <= ?").bind(t - DAY),
    env.DB.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").bind(t - DAY),
    env.DB.prepare("DELETE FROM oauth_access WHERE expires_at <= ?").bind(t),
    env.DB.prepare("DELETE FROM oauth_refresh WHERE rotated_at IS NOT NULL AND rotated_at <= ?").bind(t - 30 * DAY),
    env.DB.prepare("DELETE FROM idempotency WHERE created_at <= ?").bind(t - 7 * DAY),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(t),
    // Claims that ran out: the conditional claim already ignores them; this only tidies up.
    env.DB.prepare("UPDATE items SET claim_id = NULL, claim_expires_at = NULL WHERE claim_id IS NOT NULL AND claim_expires_at <= ?").bind(t),
    env.DB.prepare("UPDATE digests SET claim_id = NULL, claim_expires_at = NULL WHERE claim_id IS NOT NULL AND claim_expires_at <= ?").bind(t),
    env.DB.prepare("UPDATE deep_read_queue SET claim_id = NULL, claim_expires_at = NULL WHERE claim_id IS NOT NULL AND claim_expires_at <= ?").bind(t),
    env.DB.prepare("UPDATE claims SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").bind(t),
    env.DB.prepare("DELETE FROM claims WHERE expires_at <= ?").bind(t - 30 * DAY),
    env.DB.prepare("DELETE FROM daily_caps WHERE day < ?").bind(new Date(t - 3 * DAY).toISOString().slice(0, 10)),
  ]);
}

export async function runHourly(env: Env): Promise<void> {
  await step("expire", () => expireItems(env));
  await step("archive", () => cleanArchive(env));
  await step("queue", () => cleanQueue(env));
  await step("assets", () => cleanAssets(env));
  await step("tables", () => cleanTables(env));
  await step("record", () => recordRun(env, CRON_KEYS.hourly));
}
