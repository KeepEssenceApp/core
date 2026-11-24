import { describe, expect, it } from "vitest";
import { advance, DAY, MINUTE } from "../src/clock";
import { call, connectDevice, db, loginCode, makeEnv, signIn, TZ } from "./helpers";

const ask = (env: any, tier = "read") => call(env, "POST", "/v1/device-codes", { body: { device_name: "Reader", client: "eink", requested_tier: tier } });

describe("K2 short codes", () => {
  it("K2 short codes: a client shows a code, a manage device approves, and the credential comes back exactly once", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const created = await ask(env);
    expect(created.status).toBe(201);
    expect(created.json.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
    expect(created.json.approve_url).toContain("https://app.test/approve?code=");
    const { code, poll_secret } = created.json;

    expect((await call(env, "GET", `/v1/device-codes/${code}`, { token: poll_secret })).json).toEqual({ status: "pending" });
    const info = await call(env, "GET", `/v1/device-codes/${code}/request`, { token: ann.token });
    expect(info.json).toMatchObject({ device_name: "Reader", client: "eink", requested_tier: "read" });

    const approved = await call(env, "POST", `/v1/device-codes/${code}/approve`, { token: ann.token, body: {} });
    expect(approved.status).toBe(200);
    expect(approved.json.tier).toBe("read");

    const first = await call(env, "GET", `/v1/device-codes/${code}`, { token: poll_secret });
    expect(first.json.status).toBe("approved");
    const credential = first.json.grant.credential;
    expect((await call(env, "GET", "/v1/devices/me", { token: credential })).json.device.tier).toBe("read");
    // Only once.
    expect((await call(env, "GET", `/v1/device-codes/${code}`, { token: poll_secret })).status).toBe(410);
    // The code and the credential are not stored in the clear.
    const dump = JSON.stringify([await db(env, "SELECT * FROM device_codes"), await db(env, "SELECT * FROM devices")]);
    expect(dump).not.toContain(credential);
    expect(dump).not.toContain(poll_secret);
    expect(dump).not.toContain(code);
  });

  it("K2 short codes: the code alone is not enough to poll; the poll_secret is needed", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const created = await ask(env);
    await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: {} });
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}`)).status).toBe(401);
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}`, { token: "guess" })).status).toBe(401);
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}`, { token: created.json.poll_secret })).json.status).toBe("approved");
  });

  it("K2 short codes: a code lasts 10 minutes", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const created = await ask(env);
    advance(10 * MINUTE + 1000);
    expect((await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: {} })).status).toBe(410);
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}/request`, { token: ann.token })).status).toBe(410);
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}`, { token: created.json.poll_secret })).status).toBe(410);
  });

  it("K2 short codes: a code can be approved only once", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const created = await ask(env);
    expect((await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: {} })).status).toBe(200);
    expect((await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: {} })).status).toBe(410);
    expect((await db(env, "SELECT id FROM devices")).length).toBe(2);
  });

  it("K2 short codes: the tier may be lowered when approving, never raised", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const a = await ask(env, "read");
    const raised = await call(env, "POST", `/v1/device-codes/${a.json.code}/approve`, { token: ann.token, body: { tier: "manage" } });
    expect(raised.status).toBe(400);
    const lowered = await call(env, "POST", `/v1/device-codes/${a.json.code}/approve`, { token: ann.token, body: { tier: "save", device_name: "Kitchen screen" } });
    expect(lowered.status).toBe(200);
    expect(lowered.json).toMatchObject({ tier: "save", name: "Kitchen screen" });
  });

  it("K2 short codes: a denied code tells the waiting client so, and only a manage device can approve", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    const created = await ask(env);
    expect((await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: reader.token, body: {} })).status).toBe(403);
    expect((await call(env, "POST", `/v1/device-codes/${created.json.code}/deny`, { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", `/v1/device-codes/${created.json.code}`, { token: created.json.poll_secret })).json).toEqual({ status: "denied" });
  });
});

describe("K3 devices", () => {
  it("K3 devices: rename and change of tier take effect at once", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "GET", "/v1/status", { token: reader.token })).status).toBe(200);
    const patched = await call(env, "PATCH", `/v1/devices/${reader.deviceId}`, { token: ann.token, body: { name: "Phone", tier: "save" } });
    expect(patched.json).toMatchObject({ name: "Phone", tier: "save" });
    expect((await call(env, "GET", "/v1/status", { token: reader.token })).status).toBe(403);
    const list = await call(env, "GET", "/v1/devices", { token: ann.token });
    expect(list.json.devices.map((d: any) => d.name).sort()).toEqual(["Phone", "Test browser"]);
    expect(list.json.devices.find((d: any) => d.id === ann.deviceId).this_device).toBe(true);
  });

  it("K3 devices: revoking takes effect at once", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "DELETE", `/v1/devices/${reader.deviceId}`, { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: reader.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/devices", { token: ann.token })).json.devices).toHaveLength(1);
  });

  it("K3 devices: the last manage device cannot be lowered or revoked; signing out is always allowed", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await connectDevice(env, ann, "read");
    for (const r of [
      await call(env, "PATCH", `/v1/devices/${ann.deviceId}`, { token: ann.token, body: { tier: "read" } }),
      await call(env, "DELETE", `/v1/devices/${ann.deviceId}`, { token: ann.token }),
    ]) {
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe("last_manager");
    }
    // With a second manage device, the first one may go.
    const code = await loginCode(env, ann.email);
    const second = await call(env, "POST", "/v1/auth/sessions", { body: { email: ann.email, code, device_name: "Second", client: "phone", timezone: TZ } });
    expect((await call(env, "DELETE", "/v1/devices/me", { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
    // Now `second` is the last manage device: it cannot be revoked from the list, but it can sign out,
    // and the user gets back in by email.
    expect((await call(env, "DELETE", `/v1/devices/${second.json.device.id}`, { token: second.json.credential })).status).toBe(409);
    expect((await call(env, "DELETE", "/v1/devices/me", { token: second.json.credential })).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: second.json.credential })).status).toBe(401);
    const again = await call(env, "POST", "/v1/auth/sessions", { body: { email: ann.email, code: await loginCode(env, ann.email), device_name: "Back again", client: "web", timezone: TZ } });
    expect(again.json.device.tier).toBe("manage");
    expect(again.json.user.id).toBe(ann.userId);
  });

  it("K3 devices: a device idle for 90 days stops working; a device in use keeps working", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read");
    for (let i = 0; i < 4; i++) {
      advance(40 * DAY);
      expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(200);
    }
    // The reader was not used for 160 days.
    expect((await call(env, "GET", "/v1/devices/me", { token: reader.token })).status).toBe(401);
    const list = await call(env, "GET", "/v1/devices", { token: ann.token });
    expect(list.json.devices.map((d: any) => d.id)).toEqual([ann.deviceId]);
    expect(list.json.devices[0].last_used_at).not.toBeNull();
  });
});
