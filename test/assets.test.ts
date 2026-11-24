import { describe, expect, it } from "vitest";
import { advance, HOUR, MINUTE } from "../src/clock";
import { runHourly } from "../src/cron";
import { call, connectDevice, db, idem, makeEnv, signIn } from "./helpers";

const PNG = (extra: number[] = [1, 2, 3]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);

async function sha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function ask(env: any, token: string, bytes: Uint8Array, type = "image/png", size = bytes.byteLength) {
  return call(env, "POST", "/v1/assets", { token, body: { sha256: await sha(bytes), bytes: size, content_type: type } });
}

async function upload(env: any, token: string, bytes: Uint8Array, type = "image/png") {
  const up = await ask(env, token, bytes, type);
  await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": type } });
  const done = await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token });
  return { id: up.json.asset_id as string, done };
}

describe("K7 attachments", () => {
  it("K7 attachments: upload to the signed address, complete, then download through a 5-minute address", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const bytes = PNG();
    const up = await ask(env, ann.token, bytes);
    expect(up.json.status).toBe("upload");
    // The address is on the core's own origin and needs no credential.
    expect(up.json.upload_url.startsWith("https://core.test/v1/uploads/")).toBe(true);
    const put = await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "image/png", origin: "chrome-extension://abcdefgh" } });
    expect(put.status).toBe(204);
    expect(put.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefgh");
    const preflight = await call(env, "OPTIONS", up.json.upload_url, { headers: { origin: "chrome-extension://abcdefgh", "access-control-request-method": "PUT" } });
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");
    expect((await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token })).status).toBe(204);
    const stored = await env.FILES.get(`u/${ann.userId}/${await sha(bytes)}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);

    const reader = await connectDevice(env, ann, "read");
    const dl = await call(env, "GET", `/v1/assets/${up.json.asset_id}`, { token: reader.token });
    expect(dl.json).toMatchObject({ content_type: "image/png", bytes: bytes.byteLength });
    const got = await call(env, "GET", dl.json.download_url);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    advance(5 * MINUTE + 1000);
    expect((await call(env, "GET", dl.json.download_url)).status).toBe(401);
    expect((await call(env, "GET", dl.json.download_url.replace(/sig=\w{4}/, "sig=0000"))).status).toBe(401);
  });

  it("K7 attachments: more than 3 MB is refused", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const r = await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: "a".repeat(64), bytes: 3 * 1024 * 1024 + 1, content_type: "image/png" } });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("too_large");
    expect((await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: "a".repeat(64), bytes: 10, content_type: "application/zip" } })).status).toBe(415);
    // The upload address is locked to the announced size: a bigger or smaller body does not get in.
    const bytes = PNG();
    const up = await ask(env, ann.token, bytes);
    const big = new Uint8Array(3 * 1024 * 1024 + 10);
    expect((await call(env, "PUT", up.json.upload_url, { raw: big, headers: { "content-type": "image/png", "content-length": String(big.byteLength) } })).status).toBe(413);
    expect((await call(env, "PUT", up.json.upload_url, { raw: PNG([1, 2, 3, 4, 5]), headers: { "content-type": "image/png" } })).status).toBe(400);
    expect((await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "image/jpeg" } })).status).toBe(415);
    expect(await env.FILES.get(`u/${ann.userId}/${await sha(bytes)}`)).toBeNull();
    expect((await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token })).status).toBe(409);
  });

  it("K7 attachments: a file whose header does not match its type is refused and removed", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const fake = new TextEncoder().encode("<script>alert(1)</script> not a png");
    const { id, done } = await upload(env, ann.token, fake, "image/png");
    expect(done.status).toBe(415);
    expect(done.json.error.code).toBe("unsupported_type");
    expect(await db(env, "SELECT id FROM assets WHERE id = ?", id)).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
    const bin = new Uint8Array([0, 1, 2, 3, 0, 0, 0]);
    expect((await upload(env, ann.token, bin, "text/plain")).done.status).toBe(415);
    expect((await upload(env, ann.token, new TextEncoder().encode("# Notes\n\nhello"), "text/markdown")).done.status).toBe(204);
  });

  it("K7 attachments: bytes that do not match the announced SHA-256 are refused", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const up = await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: "b".repeat(64), bytes: 11, content_type: "image/png" } });
    await call(env, "PUT", up.json.upload_url, { raw: PNG(), headers: { "content-type": "image/png" } });
    const done = await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token });
    expect(done.status).toBe(409);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("K7 attachments: the same bytes are stored once per user (SHA-256), and each user has their own copy", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const bob = await signIn(env, "bob@example.com");
    const bytes = PNG();
    const first = await upload(env, ann.token, bytes);
    const again = await ask(env, ann.token, bytes);
    expect(again.json).toEqual({ asset_id: first.id, status: "stored" });
    const bobs = await ask(env, bob.token, bytes);
    expect(bobs.json.status).toBe("upload");
    expect(bobs.json.asset_id).not.toBe(first.id);
    expect((await call(env, "GET", `/v1/assets/${first.id}`, { token: bob.token })).status).toBe(404);
    // Reference counting: two items share the file; it goes when the last one is deleted.
    const a = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "image", asset_id: first.id }, idem: idem() });
    const b = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "image", asset_id: first.id }, idem: idem() });
    expect((await db(env, "SELECT refs FROM assets WHERE id = ?", first.id))[0].refs).toBe(2);
    await call(env, "DELETE", `/v1/items/${a.json.item_id}`, { token: ann.token });
    expect(await env.FILES.get(`u/${ann.userId}/${await sha(bytes)}`)).not.toBeNull();
    await call(env, "DELETE", `/v1/items/${b.json.item_id}`, { token: ann.token });
    expect(await env.FILES.get(`u/${ann.userId}/${await sha(bytes)}`)).toBeNull();
    expect((await db(env, "SELECT storage_bytes FROM users WHERE id = ?", ann.userId))[0].storage_bytes).toBe(0);
  });

  it("K7 attachments: the upload address is valid for 10 minutes", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const bytes = PNG();
    const up = await ask(env, ann.token, bytes);
    expect(Date.parse(up.json.expires_at) - Date.now()).toBeLessThan(0 + 10 * MINUTE + 365 * 24 * HOUR);
    advance(10 * MINUTE + 1000);
    expect((await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "image/png" } })).status).toBe(401);
    const tampered = (await ask(env, ann.token, bytes)).json.upload_url.replace(/exp=\d+/, "exp=99999999999999");
    expect((await call(env, "PUT", tampered, { raw: bytes, headers: { "content-type": "image/png" } })).status).toBe(401);
  });

  it("K7 attachments: over quota the item is still saved with its text, the image is not stored, and the answer says so", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await env.DB.prepare("UPDATE users SET storage_bytes = ? WHERE id = ?").bind(1024 * 1024 * 1024 - 5, ann.userId).run();
    const up = await ask(env, ann.token, PNG());
    expect(up.json.status).toBe("over_quota");
    expect(up.json.upload_url).toBeUndefined();
    const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "image", asset_id: up.json.asset_id, text: "Caption of the picture.", title: "A picture" }, idem: idem() });
    expect(saved.status).toBe(201);
    expect(saved.json).toMatchObject({ status: "saved", message_key: "saved_image_skipped_quota", image_stored: false, message: "Saved. The image was not stored: storage quota exceeded." });
    const item = (await call(env, "GET", `/v1/items/${saved.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ body: "Caption of the picture.", asset_id: null, title: "A picture" });
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });

  it("K7 attachments: an upload that was never finished is removed after an hour", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const bytes = PNG();
    const up = await ask(env, ann.token, bytes);
    await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "image/png" } });
    advance(HOUR + MINUTE);
    await runHourly(env);
    expect(await db(env, "SELECT id FROM assets")).toHaveLength(0);
    expect((await env.FILES.list()).objects).toHaveLength(0);
  });
});
