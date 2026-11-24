// Small helpers: ids, encoding, hashing. All crypto is WebCrypto.
const enc = new TextEncoder();

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Uint8Array {
  const s = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(prefix: string): string {
  return prefix + "_" + b64url(crypto.getRandomValues(new Uint8Array(12)));
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
}

/** Constant-time comparison of two strings (compares their SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const p = new Uint8Array(x);
  const q = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < p.length; i++) diff |= p[i] ^ q[i];
  return diff === 0;
}

export function iso(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** Number of characters as a person counts them (code points). */
export function charLen(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** Shortens to at most `max` characters without stopping in the middle of a word or a clause:
    cuts back to the last space or punctuation mark when one is near, and ends with an ellipsis. */
export function shorten(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1);
  let cut = head.length;
  for (let i = head.length - 1; i >= Math.floor(head.length * 0.6); i--) {
    if (/[\s,;:，；：、。.!?！？]/.test(head[i])) {
      cut = i;
      break;
    }
  }
  return head.slice(0, cut).join("").replace(/[\s,;:，；：、]+$/, "") + "…";
}

export function encodeCursor(offset: number): string {
  return b64url(enc.encode(String(offset)));
}

export function decodeCursor(cursor: string | undefined | null): number {
  if (!cursor) return 0;
  try {
    const n = Number(new TextDecoder().decode(fromB64url(cursor)));
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** First sentence of a text, for a title. Never a raw address. */
export function firstSentence(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const m = clean.match(/^.*?[。！？!?]|^.*?\.(?=\s|$)/);
  let s = (m ? m[0] : clean).trim();
  if (/^https?:\/\//i.test(s)) s = "";
  return truncate(s, max);
}

export function looksLikeUrl(text: string): boolean {
  return /^\s*(https?:\/\/|www\.)\S+\s*$/i.test(text);
}
