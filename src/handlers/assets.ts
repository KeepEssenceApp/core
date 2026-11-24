// Attachments: ask to upload, upload to the core's own signed address, complete, download.
import { MINUTE, now } from "../clock";
import { LIMITS, type Env } from "../env";
import { ApiError, err } from "../errors";
import { NO_CONTENT, ok, type Handler } from "../types";
import { iso, newId, sha256Hex } from "../util";
import {
  DOWNLOAD_MINUTES,
  headerMatches,
  r2Key,
  signedDownloadUrl,
  signedUploadUrl,
  verifyDownload,
  verifyUpload,
  type AssetRow,
} from "../services/assets";

export const requestUpload: Handler = async (cx) => {
  const { sha256, bytes, content_type } = cx.body as { sha256: string; bytes: number; content_type: string };
  const user = cx.user!;
  let asset = await cx.env.DB.prepare("SELECT * FROM assets WHERE user_id = ? AND sha256 = ?").bind(user.id, sha256).first<AssetRow>();
  if (asset?.status === "stored") return ok({ asset_id: asset.id, status: "stored" });
  const overQuota = user.storage_bytes + bytes > LIMITS.storage_quota_bytes;
  if (!asset) {
    asset = {
      id: newId("fil"),
      user_id: user.id,
      sha256,
      r2_key: r2Key(user.id, sha256),
      bytes,
      content_type,
      refs: 0,
      status: overQuota ? "over_quota" : "pending",
      created_at: now(),
    };
    await cx.env.DB.prepare("INSERT INTO assets (id, user_id, sha256, r2_key, bytes, content_type, refs, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)")
      .bind(asset.id, user.id, sha256, asset.r2_key, bytes, content_type, asset.status, asset.created_at)
      .run();
  } else {
    asset.bytes = bytes;
    asset.content_type = content_type;
    asset.status = overQuota ? "over_quota" : "pending";
    await cx.env.DB.prepare("UPDATE assets SET bytes = ?, content_type = ?, status = ?, created_at = ? WHERE id = ? AND user_id = ?")
      .bind(bytes, content_type, asset.status, now(), asset.id, user.id)
      .run();
  }
  // Over quota: nothing is uploaded. Saving with this id still works; the answer then says the image was not stored.
  if (overQuota) return ok({ asset_id: asset.id, status: "over_quota" });
  const { url, expires } = await signedUploadUrl(cx.env, cx.origin, asset);
  return ok({ asset_id: asset.id, status: "upload", upload_url: url, expires_at: iso(expires) });
};

/** The upload is done: the core checks the size, the SHA-256 and the file header before it counts. */
export const completeUpload: Handler = async (cx) => {
  const user = cx.user!;
  const asset = await cx.env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").bind(cx.path.id, user.id).first<AssetRow>();
  if (!asset) throw err("not_found");
  if (asset.status === "stored") return NO_CONTENT;
  if (asset.status === "over_quota") throw err("conflict", "超出存储配额，这个文件没有上传。", "Storage quota exceeded; this file was not uploaded.");
  const object = await cx.env.FILES.get(asset.r2_key);
  if (!object) throw err("conflict", "还没有收到上传的文件。", "The uploaded bytes have not arrived.");
  const bytes = new Uint8Array(await object.arrayBuffer());
  const discard = async (e: ApiError) => {
    await cx.env.FILES.delete(asset.r2_key);
    await cx.env.DB.prepare("DELETE FROM assets WHERE id = ? AND user_id = ? AND status = 'pending'").bind(asset.id, user.id).run();
    return e;
  };
  if (bytes.byteLength > LIMITS.asset_max_bytes) throw await discard(err("too_large"));
  if (bytes.byteLength !== asset.bytes) throw await discard(err("conflict", "收到的大小和申请时说的不一样。", "The size received differs from the size announced."));
  if ((await sha256Hex(bytes)) !== asset.sha256) throw await discard(err("conflict", "收到的内容和申请时给的 SHA-256 不一致。", "The bytes received do not match the SHA-256 announced."));
  if (!headerMatches(bytes, asset.content_type)) throw await discard(err("unsupported_type"));
  await cx.env.DB.batch([
    cx.env.DB.prepare("UPDATE assets SET status = 'stored' WHERE id = ? AND user_id = ? AND status = 'pending'").bind(asset.id, user.id),
    cx.env.DB.prepare("UPDATE users SET storage_bytes = storage_bytes + ? WHERE id = ?").bind(asset.bytes, user.id),
  ]);
  return NO_CONTENT;
};

export const getAsset: Handler = async (cx) => {
  const asset = await cx.env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ? AND status = 'stored'").bind(cx.path.id, cx.user!.id).first<AssetRow>();
  if (!asset) throw err("not_found");
  return ok({
    download_url: await signedDownloadUrl(cx.env, cx.origin, cx.user!.id, asset.id),
    expires_at: iso(now() + DOWNLOAD_MINUTES * MINUTE),
    content_type: asset.content_type,
    bytes: asset.bytes,
  });
};

// ---------------------------------------------------------------- the signed addresses themselves

/** PUT /v1/uploads/{id}?exp&sig. The signature is the credential; it locks the byte count and the type. */
export async function handleUpload(env: Env, request: Request, id: string): Promise<Response> {
  const url = new URL(request.url);
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ?").bind(id, url.searchParams.get("u") ?? "").first<AssetRow>();
  if (!asset || !(await verifyUpload(env, asset, url.searchParams.get("exp"), url.searchParams.get("sig")))) throw err("unauthorized");
  if (asset.status !== "pending") throw err("conflict");
  const length = Number(request.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(length) && length > LIMITS.asset_max_bytes) throw err("too_large");
  if (Number.isFinite(length) && length !== asset.bytes) {
    throw err("bad_request", "上传的大小必须和申请时说的一样。", "The upload must have exactly the size that was announced.");
  }
  const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (type !== asset.content_type) {
    throw err("unsupported_type", "上传的类型必须和申请时说的一样。", "The upload must have exactly the type that was announced.");
  }
  if (!request.body) throw err("bad_request");
  // Stream straight into R2. The fixed-length stream fails if the body is shorter or longer than
  // announced; the counter in front of it tells "too large" apart from "wrong size".
  let received = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > asset.bytes) controller.error(new Error("longer than announced"));
      else controller.enqueue(chunk);
    },
  });
  const fixed = new FixedLengthStream(asset.bytes);
  const pump = request.body.pipeThrough(counter).pipeTo(fixed.writable);
  pump.catch(() => {});
  try {
    await Promise.all([env.FILES.put(asset.r2_key, fixed.readable, { httpMetadata: { contentType: asset.content_type } }), pump]);
  } catch {
    await env.FILES.delete(asset.r2_key).catch(() => {});
    if (received > LIMITS.asset_max_bytes) throw err("too_large");
    throw err("bad_request", "上传的大小和申请时说的不一样。", "The upload does not have the size that was announced.");
  }
  return new Response(null, { status: 204 });
}

/** GET /v1/downloads/{id}?exp&sig. Valid for 5 minutes. */
export async function handleDownload(env: Env, request: Request, id: string): Promise<Response> {
  const url = new URL(request.url);
  const userId = url.searchParams.get("u") ?? "";
  if (!(await verifyDownload(env, userId, id, url.searchParams.get("exp"), url.searchParams.get("sig")))) throw err("unauthorized");
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ? AND user_id = ? AND status = 'stored'").bind(id, userId).first<AssetRow>();
  const object = asset ? await env.FILES.get(asset.r2_key) : null;
  if (!asset || !object) throw err("not_found");
  return new Response(object.body, {
    headers: {
      "content-type": asset.content_type,
      "content-length": String(asset.bytes),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": asset.content_type.startsWith("image/") ? "inline" : "attachment",
    },
  });
}
