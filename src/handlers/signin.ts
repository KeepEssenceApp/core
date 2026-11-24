// Meta, sign-in by email code, and the operator's admin endpoints (invites, hand-out codes).
import { CONTRACT } from "../generated/contract";
import { MINUTE, now } from "../clock";
import { LIMITS, num, outbound, type Env } from "../env";
import { err, type Lang } from "../errors";
import { validTimezone } from "../time";
import { NO_CONTENT, ok, type Handler } from "../types";
import { safeEqual, sha256Hex } from "../util";
import { createDevice, createUser, deviceView, userView } from "../services/accounts";
import { ipKey, rateLimit } from "../services/guard";
import type { UserRow } from "../types";

export const getMeta: Handler = async () =>
  ok({ contract_version: CONTRACT.version, limits: CONTRACT.limits, shared_rules: CONTRACT.sharedRules });

export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function codeHash(email: string, code: string): Promise<string> {
  return sha256Hex(`login|${email}|${code}`);
}

export async function isInvited(env: Env, email: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 FROM invites WHERE email = ?").bind(email).first()) !== null;
}

/** A fresh 6-digit code for the address. It replaces any earlier one. */
export async function mintLoginCode(env: Env, email: string): Promise<{ code: string; expiresAt: number }> {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  const code = String(n).padStart(6, "0");
  const expiresAt = now() + LIMITS.login_code_minutes * MINUTE;
  await env.DB.prepare("INSERT OR REPLACE INTO login_codes (email, code_hash, attempts, expires_at, created_at) VALUES (?, ?, 0, ?, ?)")
    .bind(email, await codeHash(email, code), expiresAt, now())
    .run();
  return { code, expiresAt };
}

const MAIL_TEXT: Record<Lang, (code: string, minutes: number) => { subject: string; text: string }> = {
  zh: (code, minutes) => ({ subject: `登录验证码 ${code}`, text: `你的登录验证码是 ${code}，${minutes} 分钟内有效，只能用一次。\n如果不是你本人在登录，忽略这封邮件即可。` }),
  en: (code, minutes) => ({ subject: `Sign-in code ${code}`, text: `Your sign-in code is ${code}. It is valid for ${minutes} minutes and can be used once.\nIf you did not try to sign in, ignore this email.` }),
};

async function mailCode(env: Env, email: string, code: string, lang: Lang): Promise<void> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return; // no mail provider: the operator hands the code out
  const { subject, text } = MAIL_TEXT[lang](code, LIMITS.login_code_minutes);
  try {
    const response = await outbound(env, "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text }),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    // The answer is 202 either way; the user can ask again.
  }
}

export const requestLoginCode: Handler = async (cx) => {
  await rateLimit(cx.env, `login-code:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30), 10 * MINUTE);
  const email = normalEmail(cx.body.email);
  // The answer never says whether the address is invited.
  if (await isInvited(cx.env, email)) {
    let allowed = true;
    try {
      await rateLimit(cx.env, `login-code-email:${await sha256Hex(email)}`, 5, 10 * MINUTE);
    } catch {
      allowed = false;
    }
    if (allowed) {
      const { code } = await mintLoginCode(cx.env, email);
      const send = mailCode(cx.env, email, code, cx.body.lang ?? cx.lang);
      if (cx.exec) cx.exec.waitUntil(send);
      else await send;
    }
  }
  return { status: 202 };
};

export const signIn: Handler = async (cx) => {
  const env = cx.env;
  await rateLimit(env, `sign-in:${await ipKey(env, cx.request)}`, num(env.PUBLIC_RATE_PER_10_MIN, 30), 10 * MINUTE);
  const email = normalEmail(cx.body.email);
  const wrong = err("unauthorized", "验证码不对，或已经失效。", "The code is wrong or no longer valid.");
  const row = await env.DB.prepare("SELECT * FROM login_codes WHERE email = ?")
    .bind(email)
    .first<{ code_hash: string; attempts: number; expires_at: number }>();
  if (!row || row.expires_at <= now() || row.attempts >= LIMITS.login_code_max_attempts || !(await isInvited(env, email))) throw wrong;
  if (!(await safeEqual(row.code_hash, await codeHash(email, cx.body.code)))) {
    await env.DB.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").bind(email).run();
    throw wrong;
  }
  // Single use: only the request that deletes the code may go on.
  const used = await env.DB.prepare("DELETE FROM login_codes WHERE email = ? AND code_hash = ?").bind(email, row.code_hash).run();
  if (used.meta.changes === 0) throw wrong;
  let user = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>();
  if (!user) user = await createUser(env, email, validTimezone(cx.body.timezone) ? cx.body.timezone : "UTC", cx.lang);
  // Whoever proves the email address owns the account: the device gets the manage tier.
  const { device, credential } = await createDevice(env, user.id, cx.body.device_name.trim(), cx.body.client, "manage", true);
  return ok({ credential, device: deviceView(device, device.id, false), user: userView(user) }, 201);
};

// ---------------------------------------------------------------- admin (not part of the contract)

async function requireAdmin(env: Env, request: Request): Promise<void> {
  if (!env.ADMIN_SECRET) throw err("not_found");
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !(await safeEqual(m[1].trim(), env.ADMIN_SECRET))) throw err("unauthorized");
}

async function emailFrom(request: Request): Promise<string> {
  const body = (await request.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? normalEmail(body.email) : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw err("bad_request", "需要一个邮箱地址：{\"email\": \"…\"}。", 'An email address is needed: {"email": "…"}.');
  }
  return email;
}

export async function adminInvites(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request);
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT email, created_at FROM invites ORDER BY created_at").all<{ email: string; created_at: number }>();
    return Response.json({ invites: rows.results.map((r) => ({ email: r.email, created_at: new Date(r.created_at).toISOString() })) });
  }
  const email = await emailFrom(request);
  if (request.method === "POST") {
    await env.DB.prepare("INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)").bind(email, now()).run();
    return Response.json({ email }, { status: 201 });
  }
  // DELETE: the address can no longer sign in. Devices that are already connected keep working.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
  ]);
  return new Response(null, { status: 204 });
}

/** Mints a code for an invited address and returns it, so the operator can pass it on. */
export async function adminLoginCode(env: Env, request: Request): Promise<Response> {
  await requireAdmin(env, request);
  const email = await emailFrom(request);
  if (!(await isInvited(env, email))) throw err("not_invited");
  const { code, expiresAt } = await mintLoginCode(env, email);
  return Response.json({ email, code, expires_at: new Date(expiresAt).toISOString() }, { status: 201 });
}
