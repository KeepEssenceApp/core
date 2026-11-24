// Files in R2. Upload and download addresses point at the core itself and are signed with
// SIGNING_KEY (HMAC-SHA-256); an upload address is locked to its byte count and type.
import { HOUR, MINUTE, now } from "../clock";
import { signingKey, type Env } from "../env";
import { hmacHex, safeEqual } from "../util";

export const UPLOAD_MINUTES = 10;
export const DOWNLOAD_MINUTES = 5;

export interface AssetRow {
  id: string;
  user_id: string;
  sha256: string;
  r2_key: string;
  bytes: number;
  content_type: string;
  refs: number;
  status: "pending" | "stored" | "over_quota";
  created_at: number;
}

export function r2Key(userId: string, sha256: string): string {
  return `u/${userId}/${sha256}`;
}

function uploadMessage(a: Pick<AssetRow, "id" | "user_id" | "bytes" | "content_type">, exp: number): string {
  return `up|${a.user_id}|${a.id}|${a.bytes}|${a.content_type}|${exp}`;
}

export async function signedUploadUrl(env: Env, origin: string, asset: AssetRow): Promise<{ url: string; expires: number }> {
  const expires = now() + UPLOAD_MINUTES * MINUTE;
  const sig = await hmacHex(signingKey(env), uploadMessage(asset, expires));
  return { url: `${origin}/v1/uploads/${asset.id}?u=${asset.user_id}&exp=${expires}&sig=${sig}`, expires };
}

export async function verifyUpload(env: Env, asset: AssetRow, exp: string | null, sig: string | null): Promise<boolean> {
  const e = Number(exp);
  if (!sig || !Number.isFinite(e) || e <= now()) return false;
  return safeEqual(sig, await hmacHex(signingKey(env), uploadMessage(asset, e)));
}

export async function signedDownloadUrl(env: Env, origin: string, userId: string, assetId: string): Promise<string> {
  const expires = now() + DOWNLOAD_MINUTES * MINUTE;
  const sig = await hmacHex(signingKey(env), `dl|${userId}|${assetId}|${expires}`);
  return `${origin}/v1/downloads/${assetId}?u=${userId}&exp=${expires}&sig=${sig}`;
}

export async function verifyDownload(env: Env, userId: string, assetId: string, exp: string | null, sig: string | null): Promise<boolean> {
  const e = Number(exp);
  if (!sig || !Number.isFinite(e) || e <= now()) return false;
  return safeEqual(sig, await hmacHex(signingKey(env), `dl|${userId}|${assetId}|${e}`));
}

function startsWith(bytes: Uint8Array, ...sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/** Does the file header match the declared type? Text types must be text (no NUL bytes, valid UTF-8). */
export function headerMatches(bytes: Uint8Array, type: string): boolean {
  switch (type) {
    case "image/png":
      return startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(bytes, 0xff, 0xd8, 0xff);
    case "image/gif":
      return startsWith(bytes, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
    case "image/webp":
      return startsWith(bytes, 0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    case "application/pdf":
      return startsWith(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d);
    case "text/plain":
    case "text/markdown": {
      const head = bytes.subarray(0, 4096);
      if (head.includes(0)) return false;
      try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(head.length === bytes.length ? head : head.subarray(0, head.length - 4));
        return true;
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/** Statement: one more reference to a stored asset. */
export function refStatement(env: Env, userId: string, assetId: string, delta: 1 | -1): D1PreparedStatement {
  return env.DB.prepare("UPDATE assets SET refs = MAX(0, refs + ?) WHERE id = ? AND user_id = ?").bind(delta, assetId, userId);
}

/** Removes a stored asset that nothing refers to any more: the object, the row, and its bytes from the quota. */
export async function deleteIfUnreferenced(env: Env, userId: string, assetId: string): Promise<void> {
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").bind(assetId, userId).first<AssetRow>();
  if (!asset || asset.refs > 0) return;
  await env.FILES.delete(asset.r2_key);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assets WHERE id = ? AND user_id = ? AND refs = 0").bind(asset.id, userId),
    ...(asset.status === "stored"
      ? [env.DB.prepare("UPDATE users SET storage_bytes = MAX(0, storage_bytes - ?) WHERE id = ?").bind(asset.bytes, userId)]
      : []),
  ]);
}

/** Cron: uploads never finished within an hour, and stored files nothing referred to for a day. */
export async function cleanAssets(env: Env): Promise<number> {
  const t = now();
  const rows = await env.DB.prepare(
    `SELECT id, user_id FROM assets WHERE refs = 0 AND ((status <> 'stored' AND created_at < ?) OR (status = 'stored' AND created_at < ?)) LIMIT 20`,
  )
    .bind(t - HOUR, t - 24 * HOUR)
    .all<{ id: string; user_id: string }>();
  for (const row of rows.results) await deleteIfUnreferenced(env, row.user_id, row.id);
  return rows.results.length;
}
