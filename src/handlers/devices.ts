// Devices: short codes, the device list, rename / tier / revoke, and where notifications go.
import { MINUTE, now } from "../clock";
import { LIMITS, num } from "../env";
import { err } from "../errors";
import { NO_CONTENT, ok, type AssistantRow, type DeviceRow, type Handler, type Tier } from "../types";
import { iso, randomToken, safeEqual, sha256Hex } from "../util";
import {
  assertNotLastManager,
  assistantDeviceView,
  createDevice,
  deviceIsLive,
  deviceView,
  getUser,
  isSuspended,
  listAssistants,
  revokeAssistant,
  tierRank,
  userView,
} from "../services/accounts";
import { isPublicUrl } from "../services/fetchpage";
import { ipKey, rateLimit } from "../services/guard";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
  return `${chars.slice(0, 3)}-${chars.slice(3)}`;
}

function codeHash(code: string): Promise<string> {
  return sha256Hex("device-code|" + code.toUpperCase().replace(/[^A-Z0-9]/g, ""));
}

interface CodeRow {
  code_hash: string;
  poll_secret_hash: string;
  device_name: string;
  client: string;
  requested_tier: Tier;
  status: "pending" | "approved" | "denied" | "used";
  user_id: string | null;
  device_id: string | null;
  expires_at: number;
}

export const createDeviceCode: Handler = async (cx) => {
  await rateLimit(cx.env, `device-code:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30), 10 * MINUTE);
  const code = newCode();
  const pollSecret = "kp_" + randomToken(32);
  const expires = now() + LIMITS.device_code_minutes * MINUTE;
  await cx.env.DB.prepare(
    `INSERT INTO device_codes (code_hash, poll_secret_hash, device_name, client, requested_tier, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(await codeHash(code), await sha256Hex(pollSecret), cx.body.device_name.trim(), cx.body.client, cx.body.requested_tier, expires, now())
    .run();
  const app = cx.env.APP_ORIGIN || cx.origin;
  return ok({ code, poll_secret: pollSecret, expires_at: iso(expires), approve_url: `${app}/approve?code=${encodeURIComponent(code)}` }, 201);
};

async function loadCode(cx: Parameters<Handler>[0]): Promise<CodeRow | null> {
  return cx.env.DB.prepare("SELECT * FROM device_codes WHERE code_hash = ?").bind(await codeHash(cx.path.code)).first<CodeRow>();
}

/** The waiting client polls with its poll_secret. The credential is created and returned once. */
export const pollDeviceCode: Handler = async (cx) => {
  const row = await loadCode(cx);
  if (!row) throw err("gone");
  if (!cx.bearer || !(await safeEqual(await sha256Hex(cx.bearer), row.poll_secret_hash))) throw err("unauthorized");
  if (row.status === "denied") return ok({ status: "denied" });
  if (row.status === "used") throw err("gone");
  if (row.status === "pending") {
    if (row.expires_at <= now()) throw err("gone");
    return ok({ status: "pending" });
  }
  // A suspended account hands out nothing; the code is not used up.
  if (row.user_id && (await isSuspended(cx.env, row.user_id))) throw err("unauthorized");
  // Approved: mint the credential now, so it is never stored in the clear, and hand it over once.
  const credential = "kd_" + randomToken(32);
  const taken = await cx.env.DB.prepare("UPDATE device_codes SET status = 'used' WHERE code_hash = ? AND status = 'approved'").bind(row.code_hash).run();
  if (taken.meta.changes === 0) throw err("gone");
  const updated = await cx.env.DB.prepare(
    "UPDATE devices SET credential_hash = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND credential_hash IS NULL RETURNING *",
  )
    .bind(await sha256Hex(credential), row.device_id, row.user_id)
    .first<DeviceRow>();
  if (!updated) throw err("gone");
  const user = await getUser(cx.env, updated.user_id);
  return ok({ status: "approved", grant: { credential, device: deviceView(updated, updated.id, false), user: userView(user) } });
};

async function pendingCode(cx: Parameters<Handler>[0], missing: "not_found" | "gone"): Promise<CodeRow> {
  const row = await loadCode(cx);
  if (!row) throw err(missing);
  if (row.status !== "pending" || row.expires_at <= now()) throw err("gone");
  return row;
}

export const getDeviceCodeRequest: Handler = async (cx) => {
  const row = await pendingCode(cx, "not_found");
  return ok({ device_name: row.device_name, client: row.client, requested_tier: row.requested_tier, expires_at: iso(row.expires_at) });
};

export const approveDeviceCode: Handler = async (cx) => {
  const row = await pendingCode(cx, "gone");
  const tier: Tier = cx.body.tier ?? row.requested_tier;
  if (tierRank(tier) > tierRank(row.requested_tier)) {
    throw err("bad_request", "权限可以调低，不能调到比对方请求的高。", "The tier may be lowered, never raised above what was requested.");
  }
  // Single use: only the request that flips the code from pending may create the device.
  const taken = await cx.env.DB.prepare("UPDATE device_codes SET status = 'approving' WHERE code_hash = ? AND status = 'pending'").bind(row.code_hash).run();
  if (taken.meta.changes === 0) throw err("gone");
  const name = (cx.body.device_name ?? "").trim() || row.device_name;
  const { device } = await createDevice(cx.env, cx.user!.id, name, row.client, tier, false);
  await cx.env.DB.prepare("UPDATE device_codes SET status = 'approved', user_id = ?, device_id = ? WHERE code_hash = ?")
    .bind(cx.user!.id, device.id, row.code_hash)
    .run();
  return ok(deviceView(device, cx.device!.id, false));
};

export const denyDeviceCode: Handler = async (cx) => {
  const row = await pendingCode(cx, "gone");
  await cx.env.DB.prepare("UPDATE device_codes SET status = 'denied', user_id = ? WHERE code_hash = ? AND status = 'pending'")
    .bind(cx.user!.id, row.code_hash)
    .run();
  return NO_CONTENT;
};

export const listDevices: Handler = async (cx) => {
  const [devices, pushes] = await cx.env.DB.batch<any>([
    cx.env.DB.prepare("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at").bind(cx.user!.id),
    cx.env.DB.prepare("SELECT device_id FROM push_targets WHERE user_id = ?").bind(cx.user!.id),
  ]);
  const withPush = new Set(pushes.results.map((p: any) => p.device_id));
  const assistants = (await listAssistants(cx.env, cx.user!.id)).filter((a) => !a.built_in);
  return ok({
    devices: [
      ...(devices.results as DeviceRow[]).filter(deviceIsLive).map((d) => deviceView(d, cx.device!.id, withPush.has(d.id))),
      ...assistants.map(assistantDeviceView),
    ],
  });
};

export const getThisDevice: Handler = async (cx) => {
  const push = await cx.env.DB.prepare("SELECT 1 FROM push_targets WHERE device_id = ? AND user_id = ?").bind(cx.device!.id, cx.user!.id).first();
  return ok({ device: deviceView(cx.device!, cx.device!.id, push !== null), user: userView(cx.user!) });
};

async function revokeClientDevice(cx: Parameters<Handler>[0], device: DeviceRow, guardLastManager = true): Promise<void> {
  if (guardLastManager && device.tier === "manage") await assertNotLastManager(cx.env, cx.user!.id, device.id);
  await cx.env.DB.batch([
    cx.env.DB.prepare("UPDATE devices SET revoked_at = ?, credential_hash = NULL WHERE id = ? AND user_id = ?").bind(now(), device.id, cx.user!.id),
    cx.env.DB.prepare("DELETE FROM push_targets WHERE device_id = ? AND user_id = ?").bind(device.id, cx.user!.id),
  ]);
}

/** Signing out is always allowed, also for the last manage device: the user can sign in again by email. */
export const signOutThisDevice: Handler = async (cx) => {
  await revokeClientDevice(cx, cx.device!, false);
  return NO_CONTENT;
};

export const registerPush: Handler = async (cx) => {
  const { endpoint, keys } = cx.body;
  if (!endpoint.startsWith("https://") || !isPublicUrl(endpoint)) {
    throw err("bad_request", "通知地址必须是公网的 https 地址。", "The notification endpoint must be a public https address.");
  }
  await cx.env.DB.prepare(
    "INSERT OR REPLACE INTO push_targets (device_id, user_id, kind, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'webpush', ?, ?, ?, ?)",
  )
    .bind(cx.device!.id, cx.user!.id, endpoint, keys.p256dh, keys.auth, now())
    .run();
  return NO_CONTENT;
};

export const unregisterPush: Handler = async (cx) => {
  await cx.env.DB.prepare("DELETE FROM push_targets WHERE device_id = ? AND user_id = ?").bind(cx.device!.id, cx.user!.id).run();
  return NO_CONTENT;
};

async function findAssistant(cx: Parameters<Handler>[0], id: string): Promise<AssistantRow | null> {
  return cx.env.DB.prepare("SELECT * FROM assistants WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND built_in IS NULL")
    .bind(id, cx.user!.id)
    .first<AssistantRow>();
}

async function findDevice(cx: Parameters<Handler>[0], id: string): Promise<DeviceRow | null> {
  const d = await cx.env.DB.prepare("SELECT * FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(id, cx.user!.id).first<DeviceRow>();
  return d && deviceIsLive(d) ? d : null;
}

export const updateDevice: Handler = async (cx) => {
  const { name, tier } = cx.body;
  const device = await findDevice(cx, cx.path.id);
  if (!device) {
    const assistant = await findAssistant(cx, cx.path.id);
    if (!assistant) throw err("not_found");
    if (tier !== undefined) throw err("bad_request", "助手没有权限档，它的权限是「干哪几步」。", "An assistant has no tier; its permission is the steps it may do.");
    if (name !== undefined && name.trim() !== assistant.name) {
      try {
        await cx.env.DB.prepare("UPDATE assistants SET name = ? WHERE id = ? AND user_id = ?").bind(name.trim(), assistant.id, cx.user!.id).run();
      } catch {
        throw err("conflict", "已经有一只助手叫这个名字。", "Another assistant already has this name.");
      }
      assistant.name = name.trim();
    }
    return ok(assistantDeviceView(assistant));
  }
  if (tier !== undefined && tier !== device.tier) {
    if (device.tier === "manage") await assertNotLastManager(cx.env, cx.user!.id, device.id);
    device.tier = tier;
  }
  if (name !== undefined) device.name = name.trim();
  await cx.env.DB.prepare("UPDATE devices SET name = ?, tier = ? WHERE id = ? AND user_id = ?").bind(device.name, device.tier, device.id, cx.user!.id).run();
  if (device.tier === "save") {
    await cx.env.DB.prepare("DELETE FROM push_targets WHERE device_id = ? AND user_id = ?").bind(device.id, cx.user!.id).run();
  }
  return ok(deviceView(device, cx.device!.id, false));
};

export const revokeDevice: Handler = async (cx) => {
  const device = await findDevice(cx, cx.path.id);
  if (device) {
    await revokeClientDevice(cx, device);
    return NO_CONTENT;
  }
  const assistant = await findAssistant(cx, cx.path.id);
  if (!assistant) throw err("not_found");
  await revokeAssistant(cx.env, cx.user!, assistant);
  return NO_CONTENT;
};

export const getPushKey: Handler = async (cx) => {
  if (!cx.env.VAPID_PUBLIC_KEY) throw err("not_found", "这个核心没有配置通知。", "Notifications are not configured on this core.");
  return ok({ public_key: cx.env.VAPID_PUBLIC_KEY });
};
