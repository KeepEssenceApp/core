// Users, devices and assistants: who is calling, and what they may do.
import { DAY, MINUTE, now } from "../clock";
import { LIMITS, type Env } from "../env";
import { err, type Lang } from "../errors";
import type { AssistantActor, AssistantRow, DeviceRow, Step, Tier, UserRow } from "../types";
import { iso, newId, parseJson, randomToken, sha256Hex } from "../util";

const TIER_RANK: Record<Tier, number> = { save: 1, read: 2, manage: 3 };

export function tierAllows(have: Tier, need: Tier): boolean {
  return TIER_RANK[have] >= TIER_RANK[need];
}

export function tierRank(tier: Tier): number {
  return TIER_RANK[tier];
}

export function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function idleCutoff(): number {
  return now() - LIMITS.device_idle_days * DAY;
}

export function deviceIsLive(d: DeviceRow): boolean {
  return d.revoked_at === null && (d.last_used_at ?? d.created_at) > idleCutoff();
}

export async function getUser(env: Env, userId: string): Promise<UserRow> {
  const user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<UserRow>();
  if (!user) throw err("unauthorized");
  return user;
}

/** Looks a device up by its credential. Revoked, unknown and idle devices are all 401. */
export async function authDevice(env: Env, bearer: string | null): Promise<{ device: DeviceRow; user: UserRow }> {
  if (!bearer) throw err("unauthorized");
  const device = await env.DB.prepare("SELECT * FROM devices WHERE credential_hash = ?")
    .bind(await sha256Hex(bearer))
    .first<DeviceRow>();
  if (!device || !deviceIsLive(device)) throw err("unauthorized");
  const user = await getUser(env, device.user_id);
  if (user.suspended_at !== null) throw err("unauthorized"); // suspended by the operator
  const t = now();
  if (!device.last_used_at || t - device.last_used_at > MINUTE) {
    await env.DB.prepare("UPDATE devices SET last_used_at = ? WHERE id = ? AND user_id = ?").bind(t, device.id, user.id).run();
    device.last_used_at = t;
  }
  return { device, user };
}

export function actorOf(row: AssistantRow): AssistantActor {
  return {
    userId: row.user_id,
    assistantId: row.id,
    name: row.name,
    kind: row.kind,
    steps: parseJson<Step[]>(row.steps, []),
    builtIn: row.built_in,
  };
}

/** Looks an assistant up by its access credential (opaque, stored hashed, one hour). */
export async function authAssistant(env: Env, bearer: string | null): Promise<AssistantActor> {
  if (!bearer) throw err("unauthorized");
  const row = await env.DB.prepare(
    `SELECT a.* FROM oauth_access c JOIN assistants a ON a.id = c.assistant_id AND a.user_id = c.user_id
     JOIN users u ON u.id = a.user_id AND u.suspended_at IS NULL
     WHERE c.credential_hash = ? AND c.expires_at > ? AND a.revoked_at IS NULL`,
  )
    .bind(await sha256Hex(bearer), now())
    .first<AssistantRow>();
  if (!row) throw err("unauthorized");
  const t = now();
  if (!row.last_seen_at || t - row.last_seen_at > MINUTE) {
    await env.DB.prepare("UPDATE assistants SET last_seen_at = ? WHERE id = ? AND user_id = ?").bind(t, row.id, row.user_id).run();
  }
  return actorOf(row);
}

/** The built-in assistant of a user, for the cron work. Null for a suspended account: nothing is done for it. */
export async function builtinActor(env: Env, userId: string, which: "dispatch" | "worker"): Promise<AssistantActor | null> {
  const row = await env.DB.prepare(
    `SELECT a.* FROM assistants a JOIN users u ON u.id = a.user_id AND u.suspended_at IS NULL
     WHERE a.user_id = ? AND a.built_in = ? AND a.revoked_at IS NULL`,
  )
    .bind(userId, which)
    .first<AssistantRow>();
  return row ? actorOf(row) : null;
}

/** Is this account suspended by the operator? Unknown accounts count as not suspended. */
export async function isSuspended(env: Env, userId: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM users WHERE id = ? AND suspended_at IS NOT NULL").bind(userId).first()) !== null;
}

/** Statements that put back everything every assistant of the account holds. */
export function releaseAllClaimsStatements(env: Env, userId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("UPDATE items SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id IS NOT NULL").bind(userId),
    env.DB.prepare("UPDATE digests SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id IS NOT NULL").bind(userId),
    env.DB.prepare("UPDATE deep_read_queue SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ? AND claim_id IS NOT NULL").bind(userId),
    env.DB.prepare("UPDATE claims SET status = 'released' WHERE user_id = ? AND status = 'active'").bind(userId),
  ];
}

const BUILTIN_NAMES: Record<"dispatch" | "worker", Record<Lang, string>> = {
  dispatch: { zh: "分派助手", en: "Dispatch assistant" },
  worker: { zh: "内置助手", en: "Built-in assistant" },
};

/** Creates the user with the two built-in assistants. The worker is the default for analysis and digest. */
export async function createUser(env: Env, email: string, timezone: string, lang: Lang): Promise<UserRow> {
  const t = now();
  const id = newId("usr");
  const dispatchId = newId("ast");
  const workerId = newId("ast");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, timezone, lang, expiry_options, role_analysis, role_digest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, email, timezone, lang, JSON.stringify(LIMITS.expiry_options_default), workerId, workerId, t),
    env.DB.prepare(
      "INSERT INTO assistants (id, user_id, name, kind, steps, built_in, connected_at) VALUES (?, ?, ?, 'scheduled', ?, 'dispatch', ?)",
    ).bind(dispatchId, id, BUILTIN_NAMES.dispatch[lang], JSON.stringify(["triage"]), t),
    env.DB.prepare(
      "INSERT INTO assistants (id, user_id, name, kind, steps, built_in, connected_at) VALUES (?, ?, ?, 'scheduled', ?, 'worker', ?)",
    ).bind(workerId, id, BUILTIN_NAMES.worker[lang], JSON.stringify(["analysis", "digest"]), t),
  ]);
  return getUser(env, id);
}

export async function createDevice(
  env: Env,
  userId: string,
  name: string,
  client: string,
  tier: Tier,
  withCredential: boolean,
): Promise<{ device: DeviceRow; credential: string | null }> {
  const credential = withCredential ? "kd_" + randomToken(32) : null;
  const device: DeviceRow = {
    id: newId("dev"),
    user_id: userId,
    name,
    client,
    tier,
    credential_hash: credential ? await sha256Hex(credential) : null,
    created_at: now(),
    last_used_at: null,
    revoked_at: null,
  };
  await env.DB.prepare(
    "INSERT INTO devices (id, user_id, name, client, tier, credential_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(device.id, userId, name, client, tier, device.credential_hash, device.created_at)
    .run();
  return { device, credential };
}

export function deviceView(d: DeviceRow, thisDeviceId: string | null, notifications: boolean) {
  return {
    id: d.id,
    name: d.name,
    category: "client" as const,
    client: d.client,
    tier: d.tier,
    created_at: iso(d.created_at),
    last_used_at: iso(d.last_used_at),
    notifications,
    this_device: d.id === thisDeviceId,
  };
}

export function assistantDeviceView(a: AssistantRow) {
  return {
    id: a.id,
    name: a.name,
    category: "assistant" as const,
    steps: parseJson<string[]>(a.steps, []),
    created_at: iso(a.connected_at ?? 0),
    last_used_at: iso(a.last_seen_at),
    notifications: false,
    this_device: false,
  };
}

export function userView(u: UserRow) {
  return { id: u.id, timezone: u.timezone, lang: u.lang };
}

export async function liveManageDevices(env: Env, userId: string): Promise<DeviceRow[]> {
  const rows = await env.DB.prepare("SELECT * FROM devices WHERE user_id = ? AND tier = 'manage' AND revoked_at IS NULL")
    .bind(userId)
    .all<DeviceRow>();
  return rows.results.filter(deviceIsLive);
}

/** Refuses when `deviceId` is the only live device with the manage tier. */
export async function assertNotLastManager(env: Env, userId: string, deviceId: string): Promise<void> {
  const live = await liveManageDevices(env, userId);
  if (live.length === 1 && live[0].id === deviceId) throw err("last_manager");
}

export async function listAssistants(env: Env, userId: string, includeRevoked = false): Promise<AssistantRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM assistants WHERE user_id = ? ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY connected_at`,
  )
    .bind(userId)
    .all<AssistantRow>();
  return rows.results;
}

/** Statements that put back everything an assistant holds. Run them in the same batch as the revocation. */
export function releaseClaimsStatements(env: Env, userId: string, assistantId: string): D1PreparedStatement[] {
  const held = "(SELECT id FROM claims WHERE user_id = ?1 AND assistant_id = ?2 AND status = 'active')";
  return [
    env.DB.prepare(`UPDATE items SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ?1 AND claim_id IN ${held}`).bind(
      userId,
      assistantId,
    ),
    env.DB.prepare(`UPDATE digests SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ?1 AND claim_id IN ${held}`).bind(
      userId,
      assistantId,
    ),
    env.DB.prepare(
      `UPDATE deep_read_queue SET claim_id = NULL, claim_expires_at = NULL WHERE user_id = ?1 AND claim_id IN ${held}`,
    ).bind(userId, assistantId),
    env.DB.prepare("UPDATE claims SET status = 'released' WHERE user_id = ?1 AND assistant_id = ?2 AND status = 'active'").bind(
      userId,
      assistantId,
    ),
  ];
}

/**
 * Disconnects an assistant: its credentials stop working, its claims go back, and the steps it
 * was the default for fall back (analysis and digest to the built-in assistant, the rest to nobody).
 * One batch, so it is all or nothing.
 */
export async function revokeAssistant(env: Env, user: UserRow, assistant: AssistantRow): Promise<void> {
  if (assistant.built_in) {
    throw err("conflict", "内置助手不能断开。", "The built-in assistant cannot be disconnected.");
  }
  const worker = await builtinActor(env, user.id, "worker");
  const fallback = worker?.assistantId ?? null;
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE assistants SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(t, assistant.id, user.id),
    env.DB.prepare("DELETE FROM oauth_access WHERE assistant_id = ? AND user_id = ?").bind(assistant.id, user.id),
    env.DB.prepare("DELETE FROM oauth_refresh WHERE assistant_id = ? AND user_id = ?").bind(assistant.id, user.id),
    env.DB.prepare("DELETE FROM oauth_codes WHERE assistant_id = ? AND user_id = ?").bind(assistant.id, user.id),
    ...releaseClaimsStatements(env, user.id, assistant.id),
    env.DB.prepare(
      `UPDATE users SET
         role_analysis = CASE WHEN role_analysis = ?1 THEN ?2 ELSE role_analysis END,
         role_digest = CASE WHEN role_digest = ?1 THEN ?2 ELSE role_digest END,
         role_deep_read = CASE WHEN role_deep_read = ?1 THEN NULL ELSE role_deep_read END,
         role_deep_dive = CASE WHEN role_deep_dive = ?1 THEN NULL ELSE role_deep_dive END
       WHERE id = ?3`,
    ).bind(assistant.id, fallback, user.id),
    // Items still waiting for this assistant go to whoever analyses by default now.
    env.DB.prepare(
      `UPDATE items SET dispatch_to = (SELECT role_analysis FROM users WHERE id = ?1)
       WHERE user_id = ?1 AND dispatch_to = ?2 AND analysed_at IS NULL AND archived_at IS NULL`,
    ).bind(user.id, assistant.id),
  ]);
}

/** Drops every credential of an assistant and puts its claims back, without removing it from the list. */
export async function dropAssistantCredentials(env: Env, userId: string, assistantId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_access WHERE assistant_id = ? AND user_id = ?").bind(assistantId, userId),
    env.DB.prepare("DELETE FROM oauth_refresh WHERE assistant_id = ? AND user_id = ?").bind(assistantId, userId),
    ...releaseClaimsStatements(env, userId, assistantId),
  ]);
}
