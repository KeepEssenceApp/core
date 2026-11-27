// The invitation notice (spec product/mail.md): the core asks the mail provider to send each
// invitation's mail once, and never asks again.
//
// Inviting an address records it as `queued` with its own invitation id (admin.ts). The minute
// Cron (the existing `* * * * *` trigger) sends the queue here. A row goes `queued` -> `sending`
// in one conditional UPDATE, so of any number of overlapping runs exactly one wins it, and only
// the winner calls the mail provider. Nothing ever sets a row back to `queued`. Every write below
// is "this invitation id AND still in the state I expect", never by the address alone: a result
// that arrives late for an invitation that was withdrawn and issued again lands on the old
// invitation or on nothing, and cannot touch the new one.
//
// What happened decides the final state, and no final state is retried:
//   accepted                    the provider took the mail (not "delivered");
//   failed / refused            the provider answered no (a 4xx): not sent;
//   failed / error              the mail broke before the request was handed over (template, local): not sent;
//   failed / unconfirmed        the request was handed over and there was no clear answer (timeout, cut
//                               connection, 5xx, the answer could not be written, `sending` for too long):
//                               it may have gone out;
//   not_sent / no_mail_service  there was no mail service when it came to sending.
// Anything that cannot be told apart is `unconfirmed`. Rows that existed before this feature have
// no state and are never touched. The core cannot promise what the provider does with a request;
// the idempotency key (the invitation id) only reduces duplicates there.
import { MINUTE, now } from "../clock";
import type { Env } from "../env";
import type { Lang } from "../errors";
import { mailConfigured, sendMail } from "./mail";
import { mailContext, renderInviteMail } from "./mailcopy";

export type InviteMailState = "queued" | "sending" | "accepted" | "failed" | "not_sent";
export type InviteMailReason = "refused" | "error" | "unconfirmed" | "no_mail_service";

/** One run sends this many; a batch of invitations drains over a few minutes. */
export const INVITE_MAILS_PER_RUN = 10;
/** A mail still `sending` after this long is recorded as `unconfirmed`. One constant; it must stay well above SEND_TIMEOUT_MS (a send call's own timeout). */
export const SENDING_UNCONFIRMED_AFTER = 15 * MINUTE;

/** What the invite request writes for a new address: queued when mail can be sent, otherwise not sent (final). */
export function initialMailState(env: Env): { state: InviteMailState; reason: InviteMailReason | null } {
  return mailConfigured(env) ? { state: "queued", reason: null } : { state: "not_sent", reason: "no_mail_service" };
}

/**
 * Housekeeping before sending: a mail that has been `sending` too long is recorded as
 * `unconfirmed` (never resent: it may have gone out), and when mail is no longer configured the
 * queue is closed as `not_sent`, so configuring it again later does not mail people days after
 * their invitation.
 */
export async function settleInviteMails(env: Env): Promise<void> {
  const t = now();
  await env.DB.prepare(
    "UPDATE invites SET invite_mail_state = 'failed', invite_mail_reason = 'unconfirmed', invite_mail_at = ?1 WHERE invite_mail_state = 'sending' AND invite_mail_at <= ?2",
  )
    .bind(t, t - SENDING_UNCONFIRMED_AFTER)
    .run();
  if (!mailConfigured(env)) {
    await env.DB.prepare("UPDATE invites SET invite_mail_state = 'not_sent', invite_mail_reason = 'no_mail_service', invite_mail_at = ?1 WHERE invite_mail_state = 'queued'")
      .bind(t)
      .run();
  }
}

/** Writes an invitation's result: only if it is still this invitation (by id) and still `sending`. A late result for anything else is dropped. */
async function record(env: Env, inviteId: string, state: "accepted" | "failed", reason: InviteMailReason | null): Promise<void> {
  await env.DB.prepare("UPDATE invites SET invite_mail_state = ?2, invite_mail_reason = ?3, invite_mail_at = ?4 WHERE invite_id = ?1 AND invite_mail_state = 'sending'")
    .bind(inviteId, state, reason, now())
    .run();
}

interface Claimed {
  invite_id: string;
  email: string;
  lang: Lang | null;
}

async function sendOne(env: Env, row: Claimed): Promise<void> {
  // Withdrawn between the claim and now (the row is gone, or is another invitation): nothing goes out.
  const current = await env.DB.prepare("SELECT 1 FROM invites WHERE invite_id = ?1 AND invite_mail_state = 'sending'").bind(row.invite_id).first();
  if (!current) return;
  let mail;
  try {
    mail = renderInviteMail(row.lang ?? "en", mailContext(env));
  } catch {
    // Broken before anything was handed to the provider: certainly not sent.
    await record(env, row.invite_id, "failed", "error");
    return;
  }
  const result = await sendMail(env, { to: row.email, ...mail, idempotencyKey: row.invite_id });
  if (result.outcome === "accepted") {
    await record(env, row.invite_id, "accepted", null);
    return;
  }
  // The provider's own words stay out of the table; the log gets them with no address and no number.
  console.warn(`invitation mail ${result.outcome}`, result.why);
  await record(env, row.invite_id, "failed", result.outcome);
}

/** The minute Cron's share: settle, then claim a few queued invitations and send each. Returns how many it claimed. */
export async function sendInviteMails(env: Env): Promise<number> {
  await settleInviteMails(env);
  if (!mailConfigured(env)) return 0;
  const claimed = await env.DB.prepare(
    `UPDATE invites SET invite_mail_state = 'sending', invite_mail_at = ?1
     WHERE invite_mail_state = 'queued'
       AND invite_id IN (SELECT invite_id FROM invites WHERE invite_mail_state = 'queued' ORDER BY created_at, rowid LIMIT ?2)
     RETURNING invite_id, email, lang`,
  )
    .bind(now(), INVITE_MAILS_PER_RUN)
    .all<Claimed>();
  for (const row of claimed.results) await sendOne(env, row);
  return claimed.results.length;
}
