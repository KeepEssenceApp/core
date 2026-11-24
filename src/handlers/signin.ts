// Meta and sign-in by email code. The operator's side (invitations, hand-out codes) is in handlers/admin.ts.
import { CONTRACT } from "../generated/contract";
import { MINUTE, now } from "../clock";
import { LIMITS, num, outbound, type Env } from "../env";
import { err, type Lang } from "../errors";
import { validTimezone } from "../time";
import { ok, type Handler } from "../types";
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

/** Invited, and not an account the operator suspended. One query. */
export async function maySignIn(env: Env, email: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT (SELECT suspended_at FROM users WHERE email = ?1) AS suspended_at FROM invites WHERE email = ?1",
  )
    .bind(email)
    .first<{ suspended_at: number | null }>();
  return row !== null && row.suspended_at === null;
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

/** True when sign-in codes can be emailed: a sender address plus either the platform's mail binding or a Resend key. */
export function mailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL_FROM && (env.EMAIL || env.RESEND_API_KEY));
}

/** Remembers how the last sign-in mail went, for the operator's overview. */
async function noteMail(env: Env, result: string): Promise<void> {
  await env.DB.prepare("INSERT INTO core_state (key, value, updated_at) VALUES ('mail.last', ?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?1, updated_at = ?2")
    .bind(result.replace(/[^\s@]+@[^\s@]+/g, "<address>").slice(0, 200), now())
    .run()
    .catch(() => {});
}

async function mailCode(env: Env, email: string, code: string, lang: Lang): Promise<void> {
  if (!mailConfigured(env)) return; // no mail provider: the operator hands the code out
  const { subject, text } = MAIL_TEXT[lang](code, LIMITS.login_code_minutes);
  try {
    // A Resend key, when set, comes first: the platform's own binding reaches only verified
    // addresses unless the sending domain is onboarded on a paid plan.
    if (env.EMAIL && !env.RESEND_API_KEY) {
      await env.EMAIL.send({ to: email, from: env.EMAIL_FROM!, subject, text });
      await noteMail(env, "sent");
      return;
    }
    const response = await outbound(env, "https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text }),
    });
    if (!response.ok) console.warn(`sign-in mail refused: ${response.status}`);
    const refusal = response.ok ? "" : (await response.clone().text().catch(() => "")).slice(0, 120);
    await noteMail(env, response.ok ? "sent" : `refused: ${response.status} ${refusal}`);
    await response.body?.cancel().catch(() => {});
  } catch (e) {
    // The answer is 202 either way; the user can ask again. Say why in the log, never the code or the address.
    const why = e instanceof Error ? e.message.replace(/[^\s@]+@[^\s@]+/g, "<address>") : "unknown";
    console.warn("sign-in mail failed", why);
    await noteMail(env, `failed: ${why}`);
  }
}

export const requestLoginCode: Handler = async (cx) => {
  await rateLimit(cx.env, `login-code:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30), 10 * MINUTE);
  const email = normalEmail(cx.body.email);
  // The answer never says whether the address is invited, nor whether the account is suspended.
  if (await maySignIn(cx.env, email)) {
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
  if (!row || row.expires_at <= now() || row.attempts >= LIMITS.login_code_max_attempts || !(await maySignIn(env, email))) throw wrong;
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
