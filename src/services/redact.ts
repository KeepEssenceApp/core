// Masks what must not leave this deployment inside free text a user typed: email addresses, phone
// numbers and anything that looks like a credential. Used where such text is passed on to a place
// the operator does not control alone (an issue tracker). It errs on the side of masking: a plain
// word turned into a mask costs a moment of reading, a credential left in costs much more.

export type Kind = "email" | "phone" | "secret";
export type Found = Record<Kind, number>;

export const noFound = (): Found => ({ email: 0, phone: 0, secret: 0 });

const MASK: Record<Kind, string> = { email: "[email]", phone: "[phone]", secret: "[secret]" };

const TOKEN = "[A-Za-z0-9._~+/=-]";

// Credentials, most specific first. Each one is replaced whole.
const SECRETS: RegExp[] = [
  // A key block. A pasted block that was cut short is masked to the end of the text.
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g,
  // Keys and tokens with a well-known prefix: OpenAI/Anthropic, GitHub, GitLab, Slack, Stripe, AWS, Google.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bglpat-[A-Za-z0-9_-]{8,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{8,}/g,
  /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  // A web token: three dot-separated parts, the first two start like JSON.
  /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  // "Bearer abc123…": the word alone ("bearer authentication") is not a credential, so the token
  // has to contain a digit or one of the characters tokens are made of.
  new RegExp(`\\bBearer\\s+(?=${TOKEN}*[\\d._~+/=-])${TOKEN}{8,}`, "gi"),
  // "password: hunter2", "api_key=…", "Authorization: Basic …": the value after the name.
  /\b(?:pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|authorization|credentials?)\s*[:=]\s*(?!\[secret\])(?:(?:Bearer|Basic|Token)\s+)?(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
];

// Address: letters and digits (any script), dots and the like before the @, a domain with a dot after.
const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

// Seven to fifteen digits with the usual separators between them: +1 415-555-0132, (020) 7946 0958,
// 138 0013 8000, 13800138000. A date is not a number to call.
const PHONE = /(?<![\w.])\+?\(?\d[\d (). -]{5,}\d(?![\w])/g;
const DATE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$|^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `text` with emails, phone numbers and credentials masked, and how many of each were found.
 * `exact` are values that are masked wherever they still occur, whatever they look like (the
 * sender's own address, a token this deployment holds).
 */
export function redact(text: string, exact: Array<string | null | undefined> = []): { text: string; found: Found } {
  const found = noFound();
  let out = text;
  for (const re of SECRETS) {
    out = out.replace(re, () => {
      found.secret++;
      return MASK.secret;
    });
  }
  out = out.replace(EMAIL, () => {
    found.email++;
    return MASK.email;
  });
  out = out.replace(PHONE, (m) => {
    const digits = m.replace(/\D/g, "").length;
    if (digits < 7 || digits > 15 || DATE.test(m.trim())) return m;
    found.phone++;
    return MASK.phone;
  });
  for (const value of exact) {
    if (!value || value.length < 4) continue;
    out = out.replace(new RegExp(escaped(value), "gi"), () => {
      found.secret++;
      return MASK.secret;
    });
  }
  return { text: out, found };
}

/** "2 emails, 1 secret" — what was masked, in a few words. Empty when nothing was. */
export function foundSentence(f: Found): string {
  return (Object.keys(MASK) as Kind[])
    .filter((k) => f[k] > 0)
    .map((k) => `${f[k]} ${k}`)
    .join(", ");
}
