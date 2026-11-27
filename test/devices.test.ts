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

// QA #98 (permission copy): the Devices page may say that a manager can change a device's permission after it
// is connected. That is a different operation from approving a code, and the core's policy is unchanged:
//   - approving a code: the permission may be lowered, never raised above what the client asked for (B10);
//   - afterwards: a manager device may set any permission on any other device, except that the last manager
//     cannot be lowered or revoked;
//   - a device that is not a manager can do none of this.
// These are server fixtures with throw-away devices; no real account and no production state.
describe("QA #98: who may set a device's permission, and when", () => {
  const RANK = { save: 0, read: 1, manage: 2 } as const;
  const TIERS = ["save", "read", "manage"] as const;

  it("approving a code: equal or lower than requested is accepted, above it is refused, and a refusal leaves the code to be approved", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    for (const requested of TIERS) {
      for (const given of TIERS) {
        const created = await ask(env, requested);
        const r = await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: { tier: given } });
        expect(`${requested}→${given} ${r.status}`).toBe(`${requested}→${given} ${RANK[given] <= RANK[requested] ? 200 : 400}`);
        if (r.status === 200) {
          expect(r.json.tier).toBe(given);
        } else {
          // Refused above the request: nothing was created, and the same code can still be approved, at the requested tier.
          expect(r.json.error.code).toBe("bad_request");
          const again = await call(env, "POST", `/v1/device-codes/${created.json.code}/approve`, { token: ann.token, body: {} });
          expect(again.status).toBe(200);
          expect(again.json.tier).toBe(requested);
        }
      }
    }
    // Without a tier in the request, the requested one is given.
    const plain = await ask(env, "read");
    expect((await call(env, "POST", `/v1/device-codes/${plain.json.code}/approve`, { token: ann.token, body: {} })).json.tier).toBe("read");
  });

  it("afterwards a manager device may set any permission on another device, in either direction, and it takes effect at once", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reader = await connectDevice(env, ann, "read"); // it asked for read, and was approved as read
    expect((await call(env, "GET", "/v1/devices", { token: reader.token })).status).toBe(403);
    for (const tier of ["manage", "save", "read", "manage"] as const) {
      const r = await call(env, "PATCH", `/v1/devices/${reader.deviceId}`, { token: ann.token, body: { tier } });
      expect(`${tier} ${r.status} ${r.json.tier}`).toBe(`${tier} 200 ${tier}`);
      // What the device may do follows the new tier on its very next request.
      expect((await call(env, "GET", "/v1/devices", { token: reader.token })).status).toBe(tier === "manage" ? 200 : 403);
    }
  });

  it("a device that only saves or only reads cannot change, revoke, list or approve anything, and nothing changes", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const target = await connectDevice(env, ann, "read");
    for (const tier of ["save", "read"] as const) {
      const weak = await connectDevice(env, ann, tier);
      const waiting = await ask(env, "read");
      const attempts = [
        await call(env, "PATCH", `/v1/devices/${target.deviceId}`, { token: weak.token, body: { tier: "manage" } }),
        await call(env, "PATCH", `/v1/devices/${weak.deviceId}`, { token: weak.token, body: { tier: "manage" } }),
        await call(env, "DELETE", `/v1/devices/${target.deviceId}`, { token: weak.token }),
        await call(env, "GET", "/v1/devices", { token: weak.token }),
        await call(env, "GET", `/v1/device-codes/${waiting.json.code}/request`, { token: weak.token }),
        await call(env, "POST", `/v1/device-codes/${waiting.json.code}/approve`, { token: weak.token, body: {} }),
        await call(env, "POST", `/v1/device-codes/${waiting.json.code}/deny`, { token: weak.token }),
      ];
      for (const [i, r] of attempts.entries()) {
        expect(`${tier} #${i} ${r.status} ${r.json?.error?.code}`).toBe(`${tier} #${i} 403 forbidden`);
      }
      // Still pending, still the same tier, still alive.
      expect((await call(env, "GET", `/v1/device-codes/${waiting.json.code}/request`, { token: ann.token })).json.requested_tier).toBe("read");
      const list = (await call(env, "GET", "/v1/devices", { token: ann.token })).json.devices;
      expect(list.find((d: any) => d.id === target.deviceId).tier).toBe("read");
      expect(list.find((d: any) => d.id === weak.deviceId).tier).toBe(tier);
    }
  });

  it("the last manager cannot be lowered or revoked, even by itself; with two, one may be lowered and then the other is the last", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const second = await connectDevice(env, ann, "manage");
    // Two managers: lowering the second is fine.
    expect((await call(env, "PATCH", `/v1/devices/${second.deviceId}`, { token: ann.token, body: { tier: "read" } })).status).toBe(200);
    // Now `ann` is the last one: neither it nor anyone else may lower or revoke it.
    for (const token of [ann.token, second.token]) {
      const lower = await call(env, "PATCH", `/v1/devices/${ann.deviceId}`, { token, body: { tier: "read" } });
      // The lowered second device is not a manager any more: the refusal is its tier; ann's is the last-manager rule.
      expect(`${token === ann.token ? "ann" : "second"} ${lower.status} ${lower.json.error.code}`).toBe(token === ann.token ? "ann 409 last_manager" : "second 403 forbidden");
    }
    const revoke = await call(env, "DELETE", `/v1/devices/${ann.deviceId}`, { token: ann.token });
    expect(`${revoke.status} ${revoke.json.error.code}`).toBe("409 last_manager");
    // Raising the second one back makes it possible again to lower the first.
    expect((await call(env, "PATCH", `/v1/devices/${second.deviceId}`, { token: ann.token, body: { tier: "manage" } })).status).toBe(200);
    expect((await call(env, "PATCH", `/v1/devices/${ann.deviceId}`, { token: second.token, body: { tier: "read" } })).status).toBe(200);
  });
});
