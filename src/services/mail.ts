// Sending one mail: the one place that talks to the mail provider. The two mails the core sends
// (the invitation notice and the sign-in code, spec product/mail.md) both go through here.
import { outbound, type Env } from "../env";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** An identity for this one mail, handed to a provider that dedupes on it (Resend's `Idempotency-Key`). It can only reduce duplicates: it is not how the core keeps a mail to one try. */
  idempotencyKey?: string;
}

/**
 * What came back. `accepted` is the provider taking the mail: it says nothing about delivery.
 * `refused` is the provider explicitly answering no (a 4xx): the mail was not taken.
 * `unconfirmed` is everything else: a timeout, a cut connection, a call that threw, a 5xx, any
 * answer that is not clearly yes or no. The provider may or may not have the mail, so it is never
 * treated as a plain failure. Anything that cannot be told apart counts as `unconfirmed`.
 */
export type MailOutcome = { outcome: "accepted" } | { outcome: "refused" | "unconfirmed"; why: string };

/** One send call is given this long; a call that has not answered by then is `unconfirmed`. The 15-minute cut-off of a `sending` invitation must stay well above it. */
export const SEND_TIMEOUT_MS = 30_000;

/** True when mail can be sent: a sender address plus either the platform's mail binding or a Resend key. */
export function mailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL_FROM && (env.EMAIL || env.RESEND_API_KEY));
}

/**
 * A short reason a mail did not go, safe to log: no email address and no run of six or more
 * digits (a provider's error can echo what it was given, and six digits may be a sign-in code).
 * No word boundary on the digits: an echoed body arrives JSON-escaped, `\n482915\n`, where the `n`
 * before the code is a word character and `\b` would let the code through.
 */
export function safeWhy(raw: string): string {
  return raw
    .replace(/[^\s@]+@[^\s@]+/g, "<address>")
    .replace(/\d{6,}/g, "<number>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Runs `call` and gives up on it after `ms`: the caller gets an error, and the call's own signal is aborted. */
async function within<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("timed out"));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error answer's body is read for the log only, and at most this many bytes of it. */
const ERROR_BODY_BYTES = 512;

/** At most `max` bytes of the body as text, then the rest is dropped. Runs inside `within`, so a body that never ends is cut at the deadline. */
async function readSome(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      size += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return new TextDecoder().decode(joined.subarray(0, max));
}

/** Drops a body nobody needs (the answer was a plain yes). */
async function discardBody(response: Response): Promise<string> {
  await response.body?.cancel().catch(() => {});
  return "";
}

/**
 * Sends one mail, HTML and plain text together, and says what the provider answered. It never
 * throws and never writes the mail's content anywhere.
 */
export async function sendMail(env: Env, mail: Mail, timeoutMs = SEND_TIMEOUT_MS): Promise<MailOutcome> {
  try {
    // A Resend key, when set, comes first: the platform's own binding reaches only verified
    // addresses unless the sending domain is onboarded on a paid plan.
    if (env.EMAIL && !env.RESEND_API_KEY) {
      await within(timeoutMs, () => env.EMAIL!.send({ to: mail.to, from: env.EMAIL_FROM!, subject: mail.subject, text: mail.text, html: mail.html }));
      return { outcome: "accepted" };
    }
    // The whole exchange has one deadline: the request, the answer's headers, and the little of the body that is
    // read for the log. A provider that sends headers and then never finishes the body cannot hold the send loop.
    const { status, ok, said } = await within(timeoutMs, async (signal) => {
      const response = await outbound(env, "https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
          ...(mail.idempotencyKey ? { "idempotency-key": mail.idempotencyKey } : {}),
        },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
        signal,
      });
      return { status: response.status, ok: response.ok, said: response.ok ? await discardBody(response) : await readSome(response, ERROR_BODY_BYTES) };
    });
    if (ok) return { outcome: "accepted" };
    // A 4xx is the provider saying no. A 5xx, a redirect or anything else may have been taken or not.
    return { outcome: status >= 400 && status < 500 ? "refused" : "unconfirmed", why: safeWhy(`${status} ${said}`) };
  } catch (e) {
    return { outcome: "unconfirmed", why: safeWhy(e instanceof Error ? e.message : "unknown") };
  }
}
