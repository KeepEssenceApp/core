// Rate limiting and idempotency, both kept in D1.
import { MINUTE, now } from "../clock";
import type { Env } from "../env";
import { ApiError, err } from "../errors";
import type { Result } from "../types";
import { sha256Hex } from "../util";

/** Counts one hit; throws 429 with Retry-After once `limit` is passed inside the window. */
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number): Promise<void> {
  const t = now();
  const win = Math.floor(t / windowMs);
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, win, count, expires_at) VALUES (?, ?, 1, ?) ON CONFLICT (key, win) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, win, (win + 1) * windowMs)
    .first<{ count: number }>();
  if (row && row.count > limit) {
    const e = err("rate_limited");
    e.headers["Retry-After"] = String(Math.max(1, Math.ceil(((win + 1) * windowMs - t) / 1000)));
    throw e;
  }
}

/** A stable, non-reversible key for the caller's address. The address itself is never stored. */
export async function ipKey(env: Env, request: Request | undefined): Promise<string> {
  const ip = request?.headers.get("cf-connecting-ip") ?? request?.headers.get("x-forwarded-for") ?? "local";
  return (await sha256Hex((env.SIGNING_KEY ?? "") + "|ip|" + ip)).slice(0, 32);
}

export const IDEMPOTENCY_DAYS = 7;

/**
 * Runs `fn` once per (user, scope, key). A repeat within 7 days gets the first response.
 * Only successful responses are remembered; a failed attempt can be retried with the same key.
 */
export async function idempotent(
  env: Env,
  userId: string,
  scope: string,
  key: string | undefined,
  fn: () => Promise<Result>,
): Promise<Result> {
  if (!key) throw err("idempotency_key_required");
  if (key.length < 8 || key.length > 128) {
    throw err("bad_request", "Idempotency-Key 的长度应在 8 到 128 之间。", "Idempotency-Key must be 8 to 128 characters long.");
  }
  const keyHash = await sha256Hex(key);
  const t = now();
  const cutoff = t - IDEMPOTENCY_DAYS * 24 * 60 * MINUTE;
  const [, inserted] = await env.DB.batch([
    env.DB.prepare("DELETE FROM idempotency WHERE user_id = ? AND scope = ? AND key_hash = ? AND created_at < ?").bind(
      userId,
      scope,
      keyHash,
      cutoff,
    ),
    env.DB.prepare("INSERT OR IGNORE INTO idempotency (user_id, scope, key_hash, status, created_at) VALUES (?, ?, ?, 0, ?)").bind(
      userId,
      scope,
      keyHash,
      t,
    ),
  ]);
  if (inserted.meta.changes === 0) {
    const row = await env.DB.prepare("SELECT status, body FROM idempotency WHERE user_id = ? AND scope = ? AND key_hash = ?")
      .bind(userId, scope, keyHash)
      .first<{ status: number; body: string | null }>();
    if (row && row.status > 0) {
      return { status: row.status, body: row.body ? JSON.parse(row.body) : undefined, headers: { "Idempotent-Replay": "true" } };
    }
    throw err("conflict", "同一个 Idempotency-Key 的请求还在处理中。", "A request with the same Idempotency-Key is still in progress.");
  }
  try {
    const result = await fn();
    await env.DB.prepare("UPDATE idempotency SET status = ?, body = ? WHERE user_id = ? AND scope = ? AND key_hash = ?")
      .bind(result.status, result.body === undefined ? null : JSON.stringify(result.body), userId, scope, keyHash)
      .run();
    return result;
  } catch (e) {
    await env.DB.prepare("DELETE FROM idempotency WHERE user_id = ? AND scope = ? AND key_hash = ? AND status = 0")
      .bind(userId, scope, keyHash)
      .run();
    if (e instanceof ApiError) throw e;
    throw e;
  }
}
