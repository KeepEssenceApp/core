// Web Push with WebCrypto only: VAPID (ES256 JWT, RFC 8292) and payload encryption
// (aes128gcm, RFC 8291 / RFC 8188).
import { now } from "../clock";
import { outbound, type Env } from "../env";
import { b64url, fromB64url } from "../util";

const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/** Encrypts `payload` for one subscription. Returns the request body. */
export async function encryptPayload(payload: Uint8Array, p256dh: string, auth: string): Promise<Uint8Array> {
  const uaPublic = fromB64url(p256dh);
  const authSecret = fromB64url(auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const local = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", local.publicKey)) as ArrayBuffer);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, local.privateKey, 256));
  const ikm = await hkdf(authSecret, secret, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 256);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 96);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export async function vapidHeader(env: Env, endpoint: string): Promise<string> {
  const publicKey = env.VAPID_PUBLIC_KEY!;
  const point = fromB64url(publicKey);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: env.VAPID_PRIVATE_KEY!,
    x: b64url(point.slice(1, 33)),
    y: b64url(point.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sub = env.APP_ORIGIN?.startsWith("https://") ? env.APP_ORIGIN : "mailto:admin@localhost.invalid";
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(
    enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now() / 1000) + 12 * 3600, sub })),
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

export type PushOutcome = "sent" | "gone" | "failed" | "off";

export async function sendPush(
  env: Env,
  target: { endpoint: string; p256dh: string; auth: string },
  message: unknown,
): Promise<PushOutcome> {
  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY) return "off";
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(message)), target.p256dh, target.auth);
    const response = await outbound(env, target.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidHeader(env, target.endpoint),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "86400",
        urgency: "normal",
      },
      body,
    });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => {});
      return "gone";
    }
    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return "sent";
    }
    // Say why in the log (the push service's own words, never the message): a refused push is
    // otherwise invisible.
    const reason = (await response.text().catch(() => "")).slice(0, 300);
    console.warn(`push refused: ${response.status} by ${new URL(target.endpoint).host}: ${reason}`);
    return "failed";
  } catch (e) {
    console.warn("push failed before it was answered", e instanceof Error ? e.message : e);
    return "failed";
  }
}
