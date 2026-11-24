import { describe, expect, it } from "vitest";
import { CONTRACT } from "../src/generated/contract";
import { call, connectAssistant, connectDevice, idem, makeEnv, saveText, signIn, tool } from "./helpers";

function fill(path: string): string {
  return path.replace("{day}", "2026-11-24").replace(/\{\w+\}/g, "x1");
}

describe("K4 tiers and isolation", () => {
  it("K4 tiers: a save-only device gets 403 on every read and manage operation of the contract", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const saver = await connectDevice(env, ann, "save");
    const ops = CONTRACT.operations.filter((o) => o.auth === "device" && (o.tier === "read" || o.tier === "manage"));
    expect(ops.length).toBeGreaterThan(30);
    for (const op of ops) {
      const r = await call(env, op.method, fill(op.path), { token: saver.token, body: op.body ? {} : undefined, idem: idem() });
      expect(`${op.operationId} ${r.status} ${r.json?.error?.code}`).toBe(`${op.operationId} 403 forbidden`);
    }
    // What it may do: save, and look at itself.
    expect((await call(env, "POST", "/v1/items", { token: saver.token, body: { kind: "text", text: "A thought." }, idem: idem() })).status).toBe(201);
    expect((await call(env, "GET", "/v1/devices/me", { token: saver.token })).status).toBe(200);
  });

  it("K4 tiers: a read device gets 403 on every manage operation, and can read", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    for (const op of CONTRACT.operations.filter((o) => o.auth === "device" && o.tier === "manage")) {
      const r = await call(env, op.method, fill(op.path), { token: reader.token, body: op.body ? {} : undefined });
      expect(`${op.operationId} ${r.status}`).toBe(`${op.operationId} 403`);
    }
    expect((await call(env, "PATCH", "/v1/settings", { token: reader.token, body: { rules: "x" } })).status).toBe(403);
    expect((await call(env, "GET", "/v1/items?state=today", { token: reader.token })).status).toBe(200);
    // Read tier sees the settings, but not the calendar image address.
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: true } });
    expect((await call(env, "GET", "/v1/settings", { token: reader.token })).json.calendar_image).toEqual({ enabled: true, url: null });
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.calendar_image.url).toMatch(/\/c\/[\w-]+\.svg$/);
  });

  it("K4 tiers: no credential, a wrong credential, a device credential on assistant operations and the reverse are all 401", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    expect((await call(env, "GET", "/v1/items?state=today")).status).toBe(401);
    expect((await call(env, "GET", "/v1/items?state=today", { token: "kd_nope" })).status).toBe(401);
    expect((await call(env, "GET", "/v1/assistant/work", { token: ann.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/items?state=today", { token: helper.access })).status).toBe(401);
    expect((await call(env, "GET", "/v1/devices", { token: helper.access })).status).toBe(401);
  });

  it("K4 isolation: one user cannot read, change or delete anything of another user", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const bob = await signIn(env, "bob@example.com");
    const itemId = await saveText(env, ann.token, "Ann's private thought about tea.", "Tea");
    const note = await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Ann's note", body: "Tea is good." }, idem: idem() });
    const annReader = await connectDevice(env, ann, "read");
    await call(env, "PUT", `/v1/deep-read-queue/${itemId}`, { token: ann.token });

    for (const [method, path, body] of [
      ["GET", `/v1/items/${itemId}`],
      ["PATCH", `/v1/items/${itemId}`, { expiry_days: 7 }],
      ["DELETE", `/v1/items/${itemId}`],
      ["PUT", `/v1/items/${itemId}/pin`],
      ["PUT", `/v1/items/${itemId}/signal`, { signal: "seen" }],
      ["PUT", `/v1/deep-read-queue/${itemId}`],
      ["POST", "/v1/deep-dive-requests", { item_id: itemId }],
      ["GET", `/v1/notes/${note.json.id}`],
      ["PATCH", `/v1/devices/${annReader.deviceId}`, { name: "Mine now" }],
      ["DELETE", `/v1/devices/${annReader.deviceId}`],
    ] as [string, string, unknown?][]) {
      const r = await call(env, method, path, { token: bob.token, body });
      expect(`${method} ${path} ${r.status}`).toBe(`${method} ${path} 404`);
    }
    for (const path of ["/v1/items?state=today", "/v1/items/search?q=tea", "/v1/notes", "/v1/notes?q=Tea", "/v1/deep-read-queue", "/v1/devices", "/v1/digests", "/v1/stats"]) {
      const r = await call(env, "GET", path, { token: bob.token });
      expect(r.status).toBe(200);
      expect(r.text).not.toContain("Tea");
      expect(r.text).not.toContain(itemId);
      expect(r.text).not.toContain(annReader.deviceId);
    }
    expect((await call(env, "GET", "/v1/status", { token: bob.token })).json.waiting).toBe(0);
    // Ann's things are untouched.
    expect((await call(env, "GET", `/v1/items/${itemId}`, { token: ann.token })).json.pinned).toBe(false);
    expect((await call(env, "GET", "/v1/devices/me", { token: annReader.token })).status).toBe(200);
  });

  it("K4 isolation: an assistant only ever sees the user who allowed it", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const bob = await signIn(env, "bob@example.com");
    const itemId = await saveText(env, ann.token, "Ann's private thought about tea.", "Tea");
    const bobsHelper = await connectAssistant(env, bob, { name: "Bob's helper" });
    expect((await call(env, "GET", `/v1/assistant/items/${itemId}/context?for=deep_dive`, { token: bobsHelper.access })).status).toBe(404);
    expect((await tool(env, bobsHelper.access, "get_context", { id: itemId, for: "deep_dive" })).status).toBe(404);
    expect((await call(env, "GET", "/v1/assistant/deep-dive-candidates", { token: bobsHelper.access })).json.candidates).toEqual([]);
    expect((await call(env, "POST", "/v1/assistant/deep-dive-requests", { token: bobsHelper.access, body: { item_id: itemId } })).status).toBe(404);
    expect((await call(env, "GET", "/v1/assistant/work", { token: bobsHelper.access })).json.work).toEqual([]);
  });
});
