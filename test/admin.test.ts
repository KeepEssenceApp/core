// The operator (admin) interface, docs/admin-api.md. Each test is named after what it proves.
import { describe, expect, it } from "vitest";
import { advance, DAY, HOUR, MINUTE } from "../src/clock";
import { runHourly, runMinute } from "../src/cron";
import { ADMIN_ROUTES, userTables } from "../src/handlers/admin";
import {
  ADMIN,
  analysis,
  builtinModel,
  call,
  claim,
  connectAssistant,
  connectDevice,
  coreTriage,
  db,
  idem,
  invite,
  LLM,
  loginCode,
  makeEnv,
  refresh,
  rpc,
  saveText,
  signIn,
  submit,
  withHelper,
  type Outbound,
  type Session,
  fillEmptyTables,
  filledUser,
  MARKER,
  PNG,
  saveImage,
  sha,
  tablesWithUserId,
} from "./helpers";

const admin = (env: any, method: string, path: string, body?: unknown) => call(env, method, path, { token: ADMIN, ...(body === undefined ? {} : { body }) });

const builtinEnv = (calls: any[] = [], extra: Record<string, unknown> = {}) => makeEnv({ ...LLM, OUTBOUND: builtinModel(calls), ...extra });

describe("admin guard", () => {
  it("admin guard: every admin route refuses a missing or wrong secret with 401, and answers 404 when no secret is configured", async () => {
    const env = makeEnv();
    const off = makeEnv({ ADMIN_SECRET: undefined });
    expect(ADMIN_ROUTES.length).toBe(19);
    for (const route of ADMIN_ROUTES) {
      const path = route.path.replace("{id}", "usr_x").replace("{device_id}", "dev_x");
      const body = route.method === "GET" ? undefined : { email: "a@b.co" };
      expect((await call(env, route.method, path, { body })).status, `${route.method} ${path} without a secret`).toBe(401);
      expect((await call(env, route.method, path, { token: "wrong", body })).status, `${route.method} ${path} with a wrong secret`).toBe(401);
      expect((await call(off, route.method, path, { token: ADMIN, body })).status, `${route.method} ${path} with no secret configured`).toBe(404);
    }
    expect((await admin(env, "GET", "/admin/invites")).status).toBe(200);
    // A user's own credential is not the operator's.
    const ann = await signIn(env);
    expect((await call(env, "GET", "/admin/users", { token: ann.token })).status).toBe(401);
  });
});

describe("admin invitations", () => {
  it("admin invites: one address is added with { email }, trimmed and lower-cased, and adding it again reports it as already there", async () => {
    const env = makeEnv();
    const first = await admin(env, "POST", "/admin/invites", { email: "  Ann@Example.com " });
    expect(first.status).toBe(201);
    expect(first.json).toEqual({ email: "ann@example.com", added: ["ann@example.com"], already: [], invalid: [] });
    const again = await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    expect(again.status).toBe(201);
    expect(again.json).toMatchObject({ added: [], already: ["ann@example.com"], invalid: [] });
    expect(await db(env, "SELECT email FROM invites")).toEqual([{ email: "ann@example.com" }]);
  });

  it("admin invites: a batch with { emails } sorts the addresses into added, already and invalid", async () => {
    const env = makeEnv();
    await invite(env, "bob@example.com");
    const r = await admin(env, "POST", "/admin/invites", { emails: ["Cy@Example.com", "bob@example.com", "not an email", " cy@example.com", 42, "dee@example.com"] });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ added: ["cy@example.com", "dee@example.com"], already: ["bob@example.com"], invalid: ["not an email", "42"] });
    expect((await db(env, "SELECT email FROM invites ORDER BY email")).map((i) => i.email)).toEqual(["bob@example.com", "cy@example.com", "dee@example.com"]);
    // Nothing to invite at all is a malformed request.
    expect((await admin(env, "POST", "/admin/invites", {})).status).toBe(400);
    expect((await admin(env, "POST", "/admin/invites", { emails: "bob@example.com" })).status).toBe(400);
    // A single address that is not one is reported, not thrown.
    expect((await admin(env, "POST", "/admin/invites", { email: "nope" })).json).toEqual({ added: [], already: [], invalid: ["nope"] });
  });

  it("admin invites: the list is newest first and shows when and as whom an invited address joined", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    advance(MINUTE);
    await invite(env, "bob@example.com");
    const list = await admin(env, "GET", "/admin/invites");
    expect(list.status).toBe(200);
    expect(list.json).toEqual({
      invites: [
        { email: "bob@example.com", invited_at: "2026-11-24T04:01:00.000Z", joined_at: null, user_id: null },
        { email: "ann@example.com", invited_at: "2026-11-24T04:00:00.000Z", joined_at: "2026-11-24T04:00:00.000Z", user_id: ann.userId },
      ],
    });
  });

  it("admin invites: removing an invitation closes sign-in for that address and leaves an existing account alone", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    await invite(env, "bob@example.com");
    await loginCode(env, "bob@example.com");
    expect((await admin(env, "DELETE", "/admin/invites", { email: "Bob@example.com" })).status).toBe(204);
    expect((await admin(env, "POST", "/admin/login-codes", { email: "bob@example.com" })).json.error.code).toBe("not_invited");
    expect(await db(env, "SELECT email FROM login_codes")).toEqual([]);
    // Ann's invitation goes too; her account and her device keep working.
    expect((await admin(env, "DELETE", "/admin/invites", { email: ann.email })).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(200);
    expect((await admin(env, "GET", `/admin/users/${ann.userId}`)).json.status).toBe("active");
    expect((await admin(env, "DELETE", "/admin/invites", { email: "nope" })).status).toBe(400);
  });

  it("admin login codes: an invited address gets a code and its expiry; an uninvited one 404 not_invited; a suspended account 409", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const r = await admin(env, "POST", "/admin/login-codes", { email: "Ann@example.com" });
    expect(r.status).toBe(201);
    expect(r.json.code).toMatch(/^\d{6}$/);
    expect(r.json.expires_at).toBe("2026-11-24T04:10:00.000Z");
    const session = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code: r.json.code, device_name: "Browser", client: "web", timezone: "UTC" } });
    expect(session.status).toBe(201);
    const stranger = await admin(env, "POST", "/admin/login-codes", { email: "stranger@example.com" });
    expect(stranger.status).toBe(404);
    expect(stranger.json.error.code).toBe("not_invited");
    await admin(env, "POST", `/admin/users/${session.json.user.id}/suspend`);
    const suspended = await admin(env, "POST", "/admin/login-codes", { email: "ann@example.com" });
    expect(suspended.status).toBe(409);
    expect(suspended.json.error.code).toBe("conflict");
    expect(await db(env, "SELECT email FROM login_codes")).toEqual([]);
  });
});

describe("admin overview", () => {
  it("admin overview: counts users, invitations, items, analyses, digests, notes, waiting work and built-in usage", async () => {
    const env = builtinEnv();
    const empty = await admin(env, "GET", "/admin/overview");
    expect(empty.status).toBe(200);
    expect(empty.json).toMatchObject({
      users: { total: 0, active_7d: 0, suspended: 0 },
      invites: { total: 0, pending: 0 },
      items: { today: 0, last_7d: 0, live: 0 },
      analyses: { today: 0, last_7d: 0 },
      digests: { last_7d: 0 },
      notes: { total: 0 },
      waiting: { triage: 0, analysis: 0 },
      usage: { today: { calls: 0, input_tokens: 0, output_tokens: 0 }, last_7d: { calls: 0, input_tokens: 0, output_tokens: 0 } },
      cron: { minute_ran_at: null, hourly_ran_at: null },
    });

    const { user: ann } = await filledUser(env); // 2 items, 2 analyses, 1 digest, 1 note; the clock is now 21:01 local
    await invite(env, "bob@example.com");
    const waitingId = await saveText(env, ann.token, "Not looked at yet.");
    const r = (await admin(env, "GET", "/admin/overview")).json;
    expect(r.users).toEqual({ total: 1, active_7d: 1, suspended: 0 });
    expect(r.invites).toEqual({ total: 2, pending: 1 });
    expect(r.items).toEqual({ today: 3, last_7d: 3, live: 3 });
    expect(r.analyses).toEqual({ today: 2, last_7d: 2 });
    expect(r.digests).toEqual({ last_7d: 1 });
    expect(r.notes).toEqual({ total: 1 });
    expect(r.waiting).toEqual({ triage: 1, analysis: 0 });
    // One triage call, two analysis calls, one digest call; the model stand-in reports 120 in and 40 out per call.
    expect(r.usage.today).toEqual({ calls: 4, input_tokens: 480, output_tokens: 160 });
    expect(r.usage.last_7d).toEqual(r.usage.today);

    // Two UTC days later "today" is empty and the week still holds what is there; a deleted item is gone from the counts.
    advance(2 * DAY);
    await call(env, "DELETE", `/v1/items/${waitingId}`, { token: ann.token });
    const later = (await admin(env, "GET", "/admin/overview")).json;
    expect(later.items).toEqual({ today: 0, last_7d: 2, live: 2 });
    expect(later.analyses).toEqual({ today: 0, last_7d: 2 });
    expect(later.usage.today).toEqual({ calls: 0, input_tokens: 0, output_tokens: 0 });
    expect(later.usage.last_7d.calls).toBe(4);
    // Suspended accounts are counted, and what waits for them is not counted as waiting work.
    await saveText(env, ann.token, "Waiting again.");
    expect((await admin(env, "GET", "/admin/overview")).json.waiting.triage).toBe(1);
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    const suspended = (await admin(env, "GET", "/admin/overview")).json;
    expect(suspended.users).toMatchObject({ total: 1, suspended: 1 });
    expect(suspended.waiting).toEqual({ triage: 0, analysis: 0 });
    // Eight days on, nobody was active in the last 7 days.
    advance(8 * DAY);
    expect((await admin(env, "GET", "/admin/overview")).json.users.active_7d).toBe(0);
  });

  it("admin overview: reports when the minute and the hourly cron last finished", async () => {
    const env = makeEnv();
    await runMinute(env);
    expect((await admin(env, "GET", "/admin/overview")).json.cron).toEqual({ minute_ran_at: "2026-11-24T04:00:00.000Z", hourly_ran_at: null });
    advance(HOUR);
    await runHourly(env);
    advance(MINUTE);
    await runMinute(env);
    expect((await admin(env, "GET", "/admin/overview")).json.cron).toEqual({ minute_ran_at: "2026-11-24T05:01:00.000Z", hourly_ran_at: "2026-11-24T05:00:00.000Z" });
  });

  it("admin overview: the config flags say what is configured without showing any secret", async () => {
    const bare = await admin(makeEnv({ LLM_MODEL: "" }), "GET", "/admin/overview");
    expect(bare.json.config).toEqual({ model: "claude-haiku-5-5 (triage), claude-sonnet-5-5 (analysis, digest)", models: { triage: { model: "claude-haiku-5-5", effort: "low" }, worker: { model: "claude-sonnet-5-5", effort: "medium" } }, model_configured: false, mail_configured: false, feedback_forwarding: false, push_configured: false, mail_last: null, version: "0.0.0-development" });
    const secrets = { LLM_API_KEY: "secret-model-key", RESEND_API_KEY: "secret-mail-key", EMAIL_FROM: "Sign in <login@example.com>", VAPID_PRIVATE_KEY: "secret-vapid-private", VAPID_PUBLIC_KEY: "vapid-public" };
    const full = await admin(makeEnv({ ...secrets, LLM_MODEL: "some-model", CORE_VERSION: "1.4.0" }), "GET", "/admin/overview");
    expect(full.json.config).toEqual({ model: "some-model", models: { triage: { model: "some-model", effort: "low" }, worker: { model: "some-model", effort: "medium" } }, model_configured: true, mail_configured: true, feedback_forwarding: false, push_configured: true, mail_last: null, version: "1.4.0" });
    for (const value of [...Object.values(secrets), ADMIN, "test-signing-key"]) expect(full.text).not.toContain(value);
    // Half of a pair is not "configured".
    const half = await admin(makeEnv({ RESEND_API_KEY: "k", VAPID_PUBLIC_KEY: "p" }), "GET", "/admin/overview");
    expect(half.json.config).toMatchObject({ mail_configured: false, push_configured: false });
  });
});

describe("admin users", () => {
  it("admin users: the list is newest first with each account's counts, and pages with an opaque cursor", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    advance(MINUTE);
    const bob = await signIn(env, "bob@example.com");
    advance(MINUTE);
    const cy = await signIn(env, "cy@example.com", "zh");
    await connectDevice(env, ann, "read");
    await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    const kept = await saveText(env, ann.token, "One to keep.");
    const gone = await saveText(env, ann.token, "One to drop.");
    await call(env, "DELETE", `/v1/items/${gone}`, { token: ann.token });
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "A note", body: "Text.", item_id: kept }, idem: idem() });
    const bytes = PNG([7, 7, 7]);
    await saveImage(env, ann.token, bytes);
    advance(5 * MINUTE);
    await call(env, "GET", "/v1/devices/me", { token: ann.token });

    const all = await admin(env, "GET", "/admin/users");
    expect(all.status).toBe(200);
    expect(all.json.next_cursor).toBeNull();
    expect(all.json.users.map((u: any) => u.id)).toEqual([cy.userId, bob.userId, ann.userId]);
    expect(all.json.users[2]).toEqual({
      id: ann.userId,
      email: "ann@example.com",
      created_at: "2026-11-24T04:00:00.000Z",
      last_active_at: "2026-11-24T04:07:00.000Z",
      status: "active",
      lang: "en",
      timezone: "Asia/Shanghai",
      devices: 2,
      assistants: 2, // the built-in assistant and Helper; the hidden dispatch assistant is not counted
      items_live: 2,
      notes: 1,
      storage_bytes: bytes.byteLength,
    });
    expect(all.json.users[0]).toMatchObject({ email: "cy@example.com", lang: "zh", devices: 1, assistants: 1, items_live: 0, notes: 0, storage_bytes: 0 });

    const first = await admin(env, "GET", "/admin/users?limit=2");
    expect(first.json.users.map((u: any) => u.id)).toEqual([cy.userId, bob.userId]);
    expect(typeof first.json.next_cursor).toBe("string");
    const second = await admin(env, "GET", `/admin/users?limit=2&cursor=${first.json.next_cursor}`);
    expect(second.json.users.map((u: any) => u.id)).toEqual([ann.userId]);
    expect(second.json.next_cursor).toBeNull();
    expect((await admin(env, "GET", "/admin/users?limit=0")).status).toBe(400);
    expect((await admin(env, "GET", "/admin/users?limit=abc")).status).toBe(400);
    expect((await admin(env, "GET", "/admin/users?cursor=%25%25")).status).toBe(400);
    expect((await admin(env, "GET", "/admin/users?limit=5000")).status).toBe(200); // capped at 200
  });

  it("admin users: q matches part of the email and status filters active or suspended accounts", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const bob = await signIn(env, "bob_b@example.org");
    const ids = async (query: string) => (await admin(env, "GET", `/admin/users?${query}`)).json.users.map((u: any) => u.id);
    expect(await ids("q=BOB")).toEqual([bob.userId]);
    expect(await ids("q=example.com")).toEqual([ann.userId]);
    expect(await ids("q=%25")).toEqual([]); // a percent sign is text, not a wildcard
    expect(await ids("q=b_b")).toEqual([bob.userId]);
    expect(await ids("q=a_n")).toEqual([]); // so is an underscore
    await admin(env, "POST", `/admin/users/${bob.userId}/suspend`);
    expect(await ids("status=suspended")).toEqual([bob.userId]);
    expect(await ids("status=active")).toEqual([ann.userId]);
    expect(await ids("status=suspended&q=ann")).toEqual([]);
    expect((await admin(env, "GET", "/admin/users?status=gone")).status).toBe(400);
  });

  it("admin users: the detail lists live devices and assistants by name, the last 30 days of counts, and usage per assistant", async () => {
    const env = builtinEnv();
    const { user: ann } = await filledUser(env);
    const reader = await connectDevice(env, ann, "read");
    const revoked = await connectDevice(env, ann, "save");
    await call(env, "DELETE", `/v1/devices/${revoked.deviceId}`, { token: ann.token });
    await call(env, "PUT", "/v1/devices/me/push", { token: ann.token, body: { kind: "webpush", endpoint: "https://push.example.net/send/ann", keys: { p256dh: "BPub", auth: "auth" } } });
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "chat", steps: ["deep_dive"] });

    const r = await admin(env, "GET", `/admin/users/${ann.userId}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ann.userId, email: "ann@example.com", status: "active", suspended_at: null, lang: "en", timezone: "Asia/Shanghai", items_live: 2, notes: 1, storage_bytes: 0 });
    expect(r.json.devices.map((d: any) => [d.id, d.name, d.client, d.tier, d.notifications])).toEqual([
      [ann.deviceId, "Test browser", "web", "manage", true],
      [reader.deviceId, "read device", "extension", "read", false],
    ]);
    expect(r.json.devices[0].created_at).toBe("2026-11-24T04:00:00.000Z");
    expect(r.json.devices[0].last_used_at).not.toBeNull();
    const builtIn = r.json.assistants.find((a: any) => a.built_in);
    expect(r.json.assistants).toEqual([
      { id: builtIn.id, name: "Built-in assistant", kind: "scheduled", built_in: true, steps: ["analysis", "digest"], connected_at: "2026-11-24T04:00:00.000Z", last_seen_at: builtIn.last_seen_at },
      { id: helper.assistantId, name: "Helper", kind: "chat", built_in: false, steps: ["deep_dive"], connected_at: "2026-11-24T13:01:00.000Z", last_seen_at: null },
    ]);
    expect(builtIn.last_seen_at).not.toBeNull();
    // Thirty days ending today in the user's time zone, zero-filled.
    expect(r.json.days).toHaveLength(30);
    expect(r.json.days[0]).toEqual({ day: "2026-10-26", saved: 0, analysed: 0, digests: 0, notes: 0 });
    expect(r.json.days[29]).toEqual({ day: "2026-11-24", saved: 2, analysed: 2, digests: 1, notes: 1 });
    // The hidden dispatch assistant is not in `assistants`, but what it used is in `usage`.
    expect(r.json.usage.map((u: any) => [u.name, u.built_in, u.calls, u.input_tokens, u.output_tokens, u.items])).toEqual([
      ["Dispatch assistant", true, 1, 120, 40, 2],
      ["Built-in assistant", true, 3, 360, 120, 3],
    ]);
    expect(r.json.assistants.some((a: any) => a.name === "Dispatch assistant")).toBe(false);

    expect((await admin(env, "GET", "/admin/users/usr_nobody")).status).toBe(404);
    for (const path of ["suspend", "restore", "sign-out"]) expect((await admin(env, "POST", `/admin/users/usr_nobody/${path}`)).status).toBe(404);
    expect((await admin(env, "DELETE", "/admin/users/usr_nobody", { confirm_email: "a@b.co" })).status).toBe(404);
  });

  it("admin sign-out: revokes every client device and reports how many; assistants keep working and the user can sign in again", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const reader = await connectDevice(env, ann, "read");
    const bob = await signIn(env, "bob@example.com");
    const r = await admin(env, "POST", `/admin/users/${ann.userId}/sign-out`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ revoked: 2 });
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/devices/me", { token: reader.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/devices/me", { token: bob.token })).status).toBe(200);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(200);
    expect((await admin(env, "POST", `/admin/users/${ann.userId}/sign-out`)).json).toEqual({ revoked: 0 });
    const code = await loginCode(env, ann.email);
    const back = await call(env, "POST", "/v1/auth/sessions", { body: { email: ann.email, code, device_name: "Again", client: "web", timezone: "UTC" } });
    expect(back.status).toBe(201);
    expect(back.json.user.id).toBe(ann.userId);
  });

  it("admin device revoke: one client device stops working, the others go on; an unknown device or another user's device is 404", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com");
    const reader = await connectDevice(env, ann, "read");
    const bob = await signIn(env, "bob@example.com");
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${reader.deviceId}`)).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: reader.token })).status).toBe(401);
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(200);
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${reader.deviceId}`)).status).toBe(204); // already revoked
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/dev_nothing`)).status).toBe(404);
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${bob.deviceId}`)).status).toBe(404);
    expect((await call(env, "GET", "/v1/devices/me", { token: bob.token })).status).toBe(200);
    // The operator may revoke the last manage device too: the user signs in again by email.
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${ann.deviceId}`)).status).toBe(204);
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
  });
});

describe("admin suspension", () => {
  it("suspension: every credential of the account is refused with 401 — client devices, assistant credentials, the assistant endpoint and token refresh", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const reader = await connectDevice(env, ann, "read");
    const bob = await signIn(env, "bob@example.com");
    await saveImage(env, ann.token, PNG([1, 1]));
    const assetId = (await db(env, "SELECT id FROM assets WHERE user_id = ?", ann.userId))[0].id;
    const download = (await call(env, "GET", `/v1/assets/${assetId}`, { token: ann.token })).json.download_url;
    expect((await call(env, "GET", download)).status).toBe(200);
    const upload = await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: await sha(PNG([2, 2])), bytes: 10, content_type: "image/png" } });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { calendar_image_enabled: true } });
    const calendar = (await call(env, "GET", "/v1/settings", { token: ann.token })).json.calendar_image.url as string;
    expect((await call(env, "GET", calendar)).status).toBe(200);
    // A short code approved before the suspension, not yet picked up.
    const pending = await call(env, "POST", "/v1/device-codes", { body: { device_name: "Late phone", client: "extension", requested_tier: "save" } });
    await call(env, "POST", `/v1/device-codes/${pending.json.code}/approve`, { token: ann.token, body: {} });

    const r = await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ann.userId, email: ann.email, status: "suspended" });
    expect((await admin(env, "GET", `/admin/users/${ann.userId}`)).json.suspended_at).toBe("2026-11-24T04:00:00.000Z");

    for (const token of [ann.token, reader.token]) {
      for (const [method, path] of [["GET", "/v1/devices/me"], ["GET", "/v1/items?state=today"], ["GET", "/v1/settings"], ["GET", "/v1/notes"]]) {
        const refused = await call(env, method, path, { token });
        expect(refused.status, `${method} ${path}`).toBe(401);
        expect(refused.json.error.code).toBe("unauthorized");
      }
    }
    expect((await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "No." }, idem: idem() })).status).toBe(401);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(401);
    expect((await call(env, "POST", "/v1/assistant/claims", { token: helper.access, body: { kind: "analysis" } })).status).toBe(401);
    const mcp = await rpc(env, helper.access, "tools/list");
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("resource_metadata");
    const refused = await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh, client_id: helper.clientId } });
    expect(refused.status).toBe(401);
    // Signed addresses handed out before, the calendar image, and a short code approved before.
    expect((await call(env, "GET", download)).status).toBe(401);
    expect((await call(env, "PUT", upload.json.upload_url, { raw: PNG([2, 2]), headers: { "content-type": "image/png" } })).status).toBe(401);
    expect((await call(env, "GET", calendar)).status).toBe(404);
    expect((await call(env, "GET", `/v1/device-codes/${pending.json.code}`, { token: pending.json.poll_secret })).status).toBe(401);
    // Somebody else's account is not affected.
    expect((await call(env, "GET", "/v1/devices/me", { token: bob.token })).status).toBe(200);
    // Suspending twice changes nothing.
    expect((await admin(env, "POST", `/admin/users/${ann.userId}/suspend`)).json.status).toBe("suspended");
    expect((await admin(env, "GET", `/admin/users/${ann.userId}`)).json.suspended_at).toBe("2026-11-24T04:00:00.000Z");
  });

  it("suspension: asking for a sign-in code still answers 202 but sends nothing, and signing in is refused", async () => {
    const mails: string[] = [];
    const outbound: Outbound = async (url) => {
      mails.push(url);
      return Response.json({ id: "mail_1" });
    };
    const env = makeEnv({ RESEND_API_KEY: "mail-key", EMAIL_FROM: "Sign in <login@example.com>", OUTBOUND: outbound });
    const ann = await signIn(env);
    // A code minted just before the suspension must not survive it.
    const early = await loginCode(env, ann.email);
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    expect(await db(env, "SELECT email FROM login_codes")).toEqual([]);
    const session = (code: string) => call(env, "POST", "/v1/auth/sessions", { body: { email: ann.email, code, device_name: "Browser", client: "web", timezone: "UTC" } });
    expect((await session(early)).status).toBe(401);

    const asked = await call(env, "POST", "/v1/auth/email-codes", { body: { email: ann.email } });
    expect(asked.status).toBe(202);
    expect(mails).toEqual([]);
    expect(await db(env, "SELECT email FROM login_codes")).toEqual([]);
    // Even a code that somehow exists does not open a session.
    const { mintLoginCode } = await import("../src/handlers/signin");
    const { code } = await mintLoginCode(env, ann.email);
    expect((await session(code)).status).toBe(401);
    expect(await db(env, "SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL", ann.userId)).toHaveLength(1);

    // Restored: the same request sends a mail again.
    await admin(env, "POST", `/admin/users/${ann.userId}/restore`);
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: ann.email } })).status).toBe(202);
    expect(mails).toEqual(["https://api.resend.com/emails"]);
  });

  it("suspension: what the account's assistants had claimed is released at that moment", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const ids = [await saveText(env, ann.token, "First."), await saveText(env, ann.token, "Second.")];
    await coreTriage(env);
    const c = await claim(env, helper.access, "analysis");
    expect(c.work).toHaveLength(2);
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toHaveLength(2);
    // Bob's assistant holds a claim of its own, which must stay.
    const bob = await signIn(env, "bob@example.com");
    const bobHelper = await connectAssistant(env, bob, { name: "Bob helper", kind: "scheduled", steps: ["analysis"] });
    await call(env, "PATCH", "/v1/settings", { token: bob.token, body: { roles: { analysis: bobHelper.assistantId } } });
    await saveText(env, bob.token, "Bob's.");
    await coreTriage(env);
    const bobClaim = await claim(env, bobHelper.access, "analysis");
    expect(bobClaim.work).toHaveLength(1);

    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    expect(await db(env, "SELECT id FROM items WHERE user_id = ? AND claim_id IS NOT NULL", ann.userId)).toEqual([]);
    expect(await db(env, "SELECT status FROM claims WHERE user_id = ?", ann.userId)).toEqual([{ status: "released" }]);
    expect(await db(env, "SELECT status FROM claims WHERE user_id = ?", bob.userId)).toEqual([{ status: "active" }]);
    expect((await submit(env, helper.access, c.claim_id, [analysis(ids[0])])).status).toBe(401);
    expect(await db(env, "SELECT item_id FROM analyses")).toEqual([]);
  });

  it("suspension: the built-in assistants and the per-user cron work skip the account, and take it up again once restored", async () => {
    const calls: any[] = [];
    const env = builtinEnv(calls);
    const ann = await signIn(env, "ann@example.com");
    const bob = await signIn(env, "bob@example.com");
    const annItem = await saveText(env, ann.token, "Ann's tea.", "Ann's tea");
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    const bobItem = await saveText(env, bob.token, "Bob's tea.", "Bob's tea");
    await runMinute(env);
    await runMinute(env);
    const state = async (id: string) => (await db(env, "SELECT triaged_at, analysed_at FROM items WHERE id = ?", id))[0];
    expect(await state(bobItem)).toMatchObject({ triaged_at: expect.any(Number), analysed_at: expect.any(Number) });
    expect(await state(annItem)).toEqual({ triaged_at: null, analysed_at: null });
    // Nothing of Ann's reached the model.
    expect(JSON.stringify(calls)).not.toContain("Ann's tea");
    // Not the core's own triage defaults after ten minutes either, nor the daily digest at 21:00.
    advance(9 * HOUR + MINUTE);
    await runMinute(env);
    await runMinute(env);
    expect(await state(annItem)).toEqual({ triaged_at: null, analysed_at: null });
    expect(await db(env, "SELECT user_id FROM digests WHERE status = 'done'")).toEqual([{ user_id: bob.userId }]);
    expect(await db(env, "SELECT user_id FROM usage_records WHERE user_id = ?", ann.userId)).toEqual([]);
    expect(JSON.stringify(calls)).not.toContain("Ann's tea");

    await admin(env, "POST", `/admin/users/${ann.userId}/restore`);
    await runMinute(env);
    await runMinute(env);
    expect(await state(annItem)).toMatchObject({ triaged_at: expect.any(Number), analysed_at: expect.any(Number) });
    expect(JSON.stringify(calls)).toContain("Ann's tea");
  });

  it("suspension: restoring brings every device and assistant back without anyone signing in again", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const reader = await connectDevice(env, ann, "read");
    const id = await saveText(env, ann.token, "Before.");
    await coreTriage(env);
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).status).toBe(401);
    // The assistant tries to renew while suspended: refused, and its refresh credential is not used up.
    expect((await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh, client_id: helper.clientId } })).status).toBe(401);
    advance(3 * DAY);

    const r = await admin(env, "POST", `/admin/users/${ann.userId}/restore`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id: ann.userId, status: "active" });
    expect((await admin(env, "GET", `/admin/users/${ann.userId}`)).json.suspended_at).toBeNull();
    // The same credentials as before, and the data is all there.
    const items = await call(env, "GET", "/v1/items?state=today", { token: ann.token });
    expect(items.status).toBe(200);
    expect(items.json.items.map((i: any) => i.id)).toEqual([id]);
    expect((await call(env, "GET", "/v1/devices/me", { token: reader.token })).status).toBe(200);
    // The assistant's access credential ran out in the meantime (one hour); its old refresh credential still renews it.
    await refresh(env, helper);
    const c = await claim(env, helper.access, "analysis");
    expect(c.work.map((w: any) => w.ref)).toEqual([id]);
    expect((await submit(env, helper.access, c.claim_id, [analysis(id)])).status).toBe(200);
    expect((await rpc(env, helper.access, "tools/list")).status).toBe(200);
    // Restoring an active account changes nothing.
    expect((await admin(env, "POST", `/admin/users/${ann.userId}/restore`)).json.status).toBe("active");
  });
});

describe("admin account deletion", () => {
  it("deletion: the tables the core walks are exactly the tables of the schema that have a user_id column", async () => {
    const env = makeEnv();
    const found = await tablesWithUserId(env);
    expect(await userTables(env)).toEqual(found);
    // The ones the first migrations created are all there, the notes index included.
    for (const table of ["items", "analyses", "digests", "notes", "notes_fts", "assets", "devices", "assistants", "claims", "usage_records", "oauth_refresh", "idempotency"]) {
      expect(found).toContain(table);
    }
    expect(found).not.toContain("admin_audit");
  });

  it("deletion: nothing with that user_id is left in any table, its files in R2 and its invitation are gone, and other accounts are untouched", async () => {
    const env = builtinEnv();
    const { user: ann } = await filledUser(env, "ann@example.com");
    await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    await connectDevice(env, ann, "read");
    await saveImage(env, ann.token, PNG([1, 2, 3]));
    await saveImage(env, ann.token, PNG([4, 5, 6]));
    await loginCode(env, ann.email);
    const bob = await signIn(env, "bob@example.com");
    await saveText(env, bob.token, "Bob keeps this.");
    await saveImage(env, bob.token, PNG([9, 9, 9]));

    const tables = await tablesWithUserId(env);
    await fillEmptyTables(env, tables, ann.userId);
    await fillEmptyTables(env, tables, bob.userId);
    // More rows in one table than one statement removes at a time (500).
    await db(env, "INSERT INTO daily_caps (user_id, day, kind, n) SELECT ?, '2026-01-01', 'bulk-' || key, 1 FROM json_each(?)", ann.userId, JSON.stringify(Array.from({ length: 1234 }, () => 0)));
    const count = async (table: string, userId: string) => (await db(env, `SELECT COUNT(*) AS n FROM "${table}" WHERE user_id = ?`, userId))[0].n as number;
    const before: Record<string, number> = {};
    for (const table of tables) {
      expect(await count(table, ann.userId), `${table} has a row of the user before`).toBeGreaterThan(0);
      before[table] = await count(table, bob.userId);
      expect(before[table], `${table} has a row of the other user`).toBeGreaterThan(0);
    }
    expect((await env.FILES.list({ prefix: `u/${ann.userId}/` })).objects).toHaveLength(2);

    // The wrong email, or none, deletes nothing.
    for (const body of [{ confirm_email: "bob@example.com" }, { confirm_email: "" }, {}]) {
      const refused = await admin(env, "DELETE", `/admin/users/${ann.userId}`, body);
      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe("bad_request");
    }
    expect(await count("items", ann.userId)).toBeGreaterThan(0);
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(200);

    const r = await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: " Ann@Example.com " });
    expect(r.status).toBe(204);
    for (const table of tables) {
      expect(await count(table, ann.userId), `${table} holds nothing of the user after`).toBe(0);
      expect(await count(table, bob.userId), `${table} still holds the other user's rows`).toBe(before[table]);
    }
    expect(await db(env, "SELECT id FROM users WHERE id = ? OR email = ?", ann.userId, ann.email)).toEqual([]);
    expect(await db(env, "SELECT email FROM invites WHERE email = ?", ann.email)).toEqual([]);
    expect(await db(env, "SELECT email FROM login_codes WHERE email = ?", ann.email)).toEqual([]);
    expect((await env.FILES.list({ prefix: `u/${ann.userId}/` })).objects).toEqual([]);
    expect((await env.FILES.list({ prefix: `u/${bob.userId}/` })).objects).toHaveLength(1);
    // The notes index holds none of the user's text any more.
    expect(await db(env, "SELECT note_id FROM notes_fts WHERE notes_fts MATCH ?", MARKER)).toEqual([]);

    // The account is gone for everyone: its credential, the operator's view, and a new sign-in.
    expect((await call(env, "GET", "/v1/devices/me", { token: ann.token })).status).toBe(401);
    expect((await admin(env, "GET", `/admin/users/${ann.userId}`)).status).toBe(404);
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: ann.email })).status).toBe(404);
    expect((await admin(env, "POST", "/admin/login-codes", { email: ann.email })).status).toBe(404);
    expect((await admin(env, "GET", "/admin/users")).json.users.map((u: any) => u.id)).toEqual([bob.userId]);
    expect((await call(env, "GET", "/v1/items?state=today", { token: bob.token })).json.items).toHaveLength(2);
  });

  it("deletion: the files of an account go even when there are more than one listing page of them", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    // Objects under the user's prefix that no row knows about are removed as well.
    for (let i = 0; i < 1005; i += 201) await Promise.all(Array.from({ length: 201 }, (_, j) => env.FILES.put(`u/${ann.userId}/stray-${i + j}`, "x")));
    await env.FILES.put(`u/${ann.userId}x/not-mine`, "x");
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: ann.email })).status).toBe(204);
    expect((await env.FILES.list({ prefix: `u/${ann.userId}/` })).objects).toEqual([]);
    expect((await env.FILES.list({ prefix: `u/${ann.userId}x/` })).objects).toHaveLength(1);
  });

  it("deletion: a suspended account can be deleted, and the same email can be invited and join afresh afterwards", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await saveText(env, ann.token, "Old.");
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    expect((await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: ann.email })).status).toBe(204);
    const again = await signIn(env, ann.email);
    expect(again.userId).not.toBe(ann.userId);
    expect((await call(env, "GET", "/v1/items?state=today", { token: again.token })).json.items).toEqual([]);
  });
});

describe("admin: no content", () => {
  it("no content: no admin response ever holds text of an item, an analysis, a daily digest or a note", async () => {
    const env = builtinEnv();
    const { user: ann, itemIds } = await filledUser(env);
    await saveImage(env, ann.token, PNG([3, 3, 3]));
    // The marker really is in every kind of content.
    const holds = async (sql: string) => JSON.stringify(await db(env, sql, ann.userId)).includes(MARKER);
    expect(await holds("SELECT title, body, opening FROM items WHERE user_id = ?")).toBe(true);
    expect(await holds("SELECT summary FROM analyses WHERE user_id = ?")).toBe(true);
    expect(await holds("SELECT worth FROM digests WHERE user_id = ? AND status = 'done'")).toBe(true);
    expect(await holds("SELECT title, body FROM notes WHERE user_id = ?")).toBe(true);
    expect(await holds("SELECT * FROM deep_read_queue WHERE user_id = ?")).toBe(false);
    expect(itemIds).toHaveLength(2);

    // Actions first, so the audit log and the suspended state are in what the GET routes return.
    const seen: string[] = [];
    const keep = (r: { status: number; text: string }, expected: number) => {
      expect(r.status).toBe(expected);
      seen.push(r.text);
    };
    keep(await admin(env, "POST", `/admin/users/${ann.userId}/suspend`), 200);
    keep(await admin(env, "POST", `/admin/users/${ann.userId}/restore`), 200);
    keep(await admin(env, "POST", "/admin/audit", { action: "portal.sign_in", target: "operator", detail: "from the portal" }), 201);

    // Feedback is left out on purpose: it is what a user wrote to the operator, and it is the one
    // list that shows a user's own words. It holds nothing of an item, analysis, digest or note.
    const gets = ADMIN_ROUTES.filter((r) => r.method === "GET" && r.path !== "/admin/feedback").map((r) => r.path.replace("{id}", ann.userId));
    expect(gets.sort()).toEqual(["/admin/audit", "/admin/fetch", "/admin/invites", "/admin/overview", "/admin/usage", "/admin/users", `/admin/users/${ann.userId}`]);
    for (const path of [...gets, "/admin/users?q=ann&status=active&limit=200", "/admin/usage?days=90", "/admin/audit?limit=200"]) {
      keep(await admin(env, "GET", path), 200);
    }
    for (const text of seen) {
      expect(text).not.toContain(MARKER);
      // Not in the random ids (usr_…, itm_…) either: sixteen random letters now and then spell "tea".
      expect(text.toLowerCase().replace(/\b[a-z]{2,5}_[a-z0-9]{8,}\b/g, "")).not.toContain("tea");
      expect(text).not.toContain("What I learnt");
    }
    // The detail does carry what it may: names of devices and assistants, and numbers.
    const detail = (await admin(env, "GET", `/admin/users/${ann.userId}`)).json;
    expect(detail.devices[0].name).toBe("Test browser");
    expect(detail.items_live).toBe(3);
    // No field of any admin response is named like content.
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) (keys.add(k), walk(v));
    };
    for (const text of seen) walk(JSON.parse(text));
    for (const banned of ["title", "body", "url", "summary", "text", "opening", "question", "worth", "points", "key_fact", "site"]) expect(keys.has(banned), banned).toBe(false);
  });
});

describe("admin usage", () => {
  it("admin usage: built-in usage per UTC day, zero-filled, and the accounts that used most", async () => {
    const env = builtinEnv();
    const { ann, helper } = await withHelper(env, ["deep_read"]);
    await saveText(env, ann.token, "Tea.", "Tea");
    await runMinute(env); // one triage call, one analysis call
    const bob = await signIn(env, "bob@example.com");
    await saveText(env, bob.token, "One.", "One");
    await saveText(env, bob.token, "Two.", "Two");
    await runMinute(env);
    await runMinute(env); // one triage call, two analysis calls
    // What a connected assistant reports about itself is not built-in usage.
    await call(env, "PUT", `/v1/deep-read-queue/${(await db(env, "SELECT id FROM items WHERE user_id = ?", ann.userId))[0].id}`, { token: ann.token });
    const c = await claim(env, helper.access, "deep_read");
    await submit(env, helper.access, c.claim_id, [{ kind: "deep_read", item_id: c.work[0].ref, read: "Read.", found: "Found.", questions: ["Why?"] }], { model: "other", input_tokens: 99999, output_tokens: 99999, calls: 50 });

    const r = await admin(env, "GET", "/admin/usage?days=3");
    expect(r.status).toBe(200);
    expect(r.json.days).toEqual([
      { day: "2026-11-22", calls: 0, input_tokens: 0, output_tokens: 0, items: 0 },
      { day: "2026-11-23", calls: 0, input_tokens: 0, output_tokens: 0, items: 0 },
      { day: "2026-11-24", calls: 5, input_tokens: 600, output_tokens: 200, items: 6 },
    ]);
    expect(r.json.top_users).toEqual([
      { user_id: bob.userId, email: "bob@example.com", calls: 3, input_tokens: 360, output_tokens: 120 },
      { user_id: ann.userId, email: "ann@example.com", calls: 2, input_tokens: 240, output_tokens: 80 },
    ]);
    expect((await admin(env, "GET", "/admin/usage")).json.days).toHaveLength(30);
    expect((await admin(env, "GET", "/admin/usage?days=90")).json.days).toHaveLength(90);
    // A day later the usage sits on yesterday's UTC day; a one-day window no longer holds it.
    advance(DAY);
    const next = (await admin(env, "GET", "/admin/usage?days=2")).json;
    expect(next.days.map((d: any) => [d.day, d.calls])).toEqual([["2026-11-24", 5], ["2026-11-25", 0]]);
    expect((await admin(env, "GET", "/admin/usage?days=1")).json).toEqual({ days: [{ day: "2026-11-25", calls: 0, input_tokens: 0, output_tokens: 0, items: 0 }], top_users: [] });
    for (const bad of ["0", "91", "abc", "1.5", "-3"]) expect((await admin(env, "GET", `/admin/usage?days=${bad}`)).status, bad).toBe(400);
  });
});

describe("admin audit log", () => {
  it("audit: every operator action is recorded by the core, newest first, with its target", async () => {
    const env = makeEnv();
    const ann = await signIn(env, "ann@example.com"); // invite.add, login_code.mint
    const reader = await connectDevice(env, ann, "read");
    await admin(env, "POST", "/admin/invites", { emails: ["bob@example.com", "cy@example.com", "ann@example.com", "x"] }); // two invite.add
    await admin(env, "DELETE", "/admin/invites", { email: "cy@example.com" });
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    await admin(env, "POST", `/admin/users/${ann.userId}/restore`);
    await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${reader.deviceId}`);
    await admin(env, "POST", `/admin/users/${ann.userId}/sign-out`);
    await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: ann.email });

    const r = await admin(env, "GET", "/admin/audit");
    expect(r.status).toBe(200);
    expect(r.json.next_cursor).toBeNull();
    expect(r.json.entries.map((e: any) => [e.action, e.target, e.detail, e.source])).toEqual([
      ["user.delete", ann.userId, "ann@example.com", "core"],
      ["user.sign_out", ann.userId, "ann@example.com; devices: 1", "core"],
      ["user.device_revoke", ann.userId, `ann@example.com; device ${reader.deviceId} (read device)`, "core"],
      ["user.restore", ann.userId, "ann@example.com", "core"],
      ["user.suspend", ann.userId, "ann@example.com", "core"],
      ["invite.remove", "cy@example.com", "", "core"],
      ["invite.add", "cy@example.com", "", "core"],
      ["invite.add", "bob@example.com", "", "core"],
      ["login_code.mint", "ann@example.com", "", "core"],
      ["invite.add", "ann@example.com", "", "core"],
    ]);
    for (const e of r.json.entries) {
      expect(e.id).toMatch(/^aud_/);
      expect(e.at).toBe("2026-11-24T04:00:00.000Z");
    }
    expect(new Set(r.json.entries.map((e: any) => e.id)).size).toBe(10);
  });

  it("audit: things that changed nothing are not recorded", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const before = (await admin(env, "GET", "/admin/audit")).json.entries.length;
    await admin(env, "POST", "/admin/invites", { email: ann.email }); // already invited
    await admin(env, "DELETE", "/admin/invites", { email: "nobody@example.com" }); // was not invited
    await admin(env, "POST", `/admin/users/${ann.userId}/restore`); // was not suspended
    await admin(env, "POST", "/admin/login-codes", { email: "nobody@example.com" }); // refused
    await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: "wrong@example.com" }); // refused
    await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/dev_none`); // refused
    expect((await admin(env, "GET", "/admin/audit")).json.entries).toHaveLength(before);
  });

  it("audit: an entry never holds a sign-in code or a credential", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com");
    const codes = [await loginCode(env, "ann@example.com"), await loginCode(env, "ann@example.com")];
    const session = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code: codes[1], device_name: "Browser", client: "web", timezone: "UTC" } });
    const ann: Session = { token: session.json.credential, deviceId: session.json.device.id, userId: session.json.user.id, email: "ann@example.com" };
    const helper = await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps: ["analysis"] });
    const reader = await connectDevice(env, ann, "read");
    codes.push((await admin(env, "POST", "/admin/login-codes", { email: ann.email })).json.code);
    await admin(env, "POST", `/admin/users/${ann.userId}/suspend`);
    await admin(env, "POST", `/admin/users/${ann.userId}/restore`);
    await admin(env, "DELETE", `/admin/users/${ann.userId}/devices/${reader.deviceId}`);
    await admin(env, "POST", `/admin/users/${ann.userId}/sign-out`);
    await admin(env, "DELETE", `/admin/users/${ann.userId}`, { confirm_email: ann.email });

    const stored = JSON.stringify(await db(env, "SELECT * FROM admin_audit"));
    const served = (await admin(env, "GET", "/admin/audit")).text;
    expect(JSON.parse(served).entries.filter((e: any) => e.action === "login_code.mint")).toHaveLength(3);
    for (const text of [stored, served]) {
      for (const code of codes) expect(text).not.toContain(code);
      for (const secret of [ann.token, reader.token, helper.access, helper.refresh, ADMIN]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/k[dacr]_[A-Za-z0-9_-]{16,}/);
    }
    // The portal cannot put one in either.
    const refused = await admin(env, "POST", "/admin/audit", { action: "portal.note", detail: `copied ${ann.token}` });
    expect(refused.status).toBe(400);
    expect((await admin(env, "POST", "/admin/audit", { action: "portal.note", target: helper.refresh })).status).toBe(400);
  });

  it("audit: the portal records its own actions with source portal; the log pages with an opaque cursor", async () => {
    const env = makeEnv();
    await invite(env, "ann@example.com"); // source core
    advance(MINUTE);
    const made = await admin(env, "POST", "/admin/audit", { action: "portal.sign_in", target: "operator", detail: "signed in" });
    expect(made.status).toBe(201);
    expect(made.json).toEqual({ id: made.json.id, at: "2026-11-24T04:01:00.000Z", action: "portal.sign_in", target: "operator", detail: "signed in", source: "portal" });
    // target and detail are optional; `source` cannot be chosen by the caller.
    const bare = await admin(env, "POST", "/admin/audit", { action: "waitlist.invite", source: "core" });
    expect(bare.json).toMatchObject({ action: "waitlist.invite", target: "", detail: "", source: "portal" });
    for (const body of [{}, { action: "" }, { action: "Has Spaces" }, { action: 7 }, { action: "a.b", detail: "x".repeat(1001) }, { action: "a.b", target: ["x"] }]) {
      expect((await admin(env, "POST", "/admin/audit", body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }

    const pages: string[][] = [];
    let cursor: string | null = null;
    do {
      const page: any = (await admin(env, "GET", `/admin/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`)).json;
      pages.push(page.entries.map((e: any) => `${e.source}:${e.action}`));
      cursor = page.next_cursor;
    } while (cursor);
    expect(pages).toEqual([["portal:waitlist.invite", "portal:portal.sign_in"], ["core:invite.add"]]);
    expect((await admin(env, "GET", "/admin/audit?cursor=nonsense")).status).toBe(400);
    expect((await admin(env, "GET", "/admin/audit?limit=-1")).status).toBe(400);
  });
});
