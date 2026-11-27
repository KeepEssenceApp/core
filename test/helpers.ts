import { createExecutionContext, env as baseEnv, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { b64url, sha256Hex } from "../src/util";

/** 2026-11-24 12:00 in Asia/Shanghai (04:00 UTC). */
export const T0 = Date.UTC(2026, 10, 24, 4, 0, 0);
export const BASE = "https://core.test";
export const ADMIN = "test-admin-secret";
export const TZ = "Asia/Shanghai";

export type Outbound = (url: string, init?: RequestInit) => Promise<Response>;

/** No test ever reaches the network: an outbound request that was not stubbed fails here. */
const noNetwork: Outbound = async (url) => new Response("outbound request not stubbed: " + url, { status: 599 });

/**
 * The test environment. Everything a developer's local .dev.vars could set is fixed here, so the
 * tests do not depend on it (and can never pick up a real model key).
 */
export function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    ...(baseEnv as unknown as Env),
    ALLOW_HTTP: "0",
    APP_ORIGIN: "https://app.test",
    PUBLIC_ORIGIN: undefined,
    ALLOWED_ORIGINS: undefined,
    ADMIN_SECRET: ADMIN,
    SIGNING_KEY: "test-signing-key",
    LLM_API_KEY: undefined,
    LLM_BASE_URL: "https://model.test",
    // No model variable at all: a test that wants one sets it, the rest get the built-in defaults of each job.
    LLM_MODEL: undefined,
    LLM_MODEL_TRIAGE: undefined,
    LLM_MODEL_WORKER: undefined,
    LLM_EFFORT_TRIAGE: undefined,
    LLM_EFFORT_WORKER: undefined,
    RESEND_API_KEY: undefined,
    EMAIL_FROM: undefined,
    VAPID_PRIVATE_KEY: undefined,
    VAPID_PUBLIC_KEY: undefined,
    WEB: undefined,
    OUTBOUND: noNetwork,
    ...extra,
  };
}

export interface Reply {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

let keySeq = 0;
export function idem(): string {
  return `test-key-${++keySeq}-${Math.random().toString(36).slice(2)}`;
}

export async function call(
  env: Env,
  method: string,
  path: string,
  opts: { token?: string | null; body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; raw?: BodyInit; idem?: string | false } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "accept-language": "en", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  } else if (opts.form) {
    body = new URLSearchParams(opts.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (opts.raw !== undefined) {
    body = opts.raw;
  }
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const url = path.startsWith("http") ? path : BASE + path;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, { method, headers, body, redirect: "manual" }), env, ctx);
  const text = new TextDecoder().decode(await res.arrayBuffer());
  await waitOnExecutionContext(ctx);
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

export async function invite(env: Env, email: string): Promise<void> {
  const r = await call(env, "POST", "/admin/invites", { token: ADMIN, body: { email } });
  if (r.status !== 201) throw new Error("invite failed " + r.text);
}

export async function loginCode(env: Env, email: string): Promise<string> {
  const r = await call(env, "POST", "/admin/login-codes", { token: ADMIN, body: { email } });
  if (r.status !== 201) throw new Error("login code failed " + r.text);
  return r.json.code;
}

export interface Session {
  token: string;
  deviceId: string;
  userId: string;
  email: string;
}

export async function signIn(env: Env, email = "ann@example.com", lang: "en" | "zh" = "en"): Promise<Session> {
  await invite(env, email);
  const code = await loginCode(env, email);
  const r = await call(env, "POST", "/v1/auth/sessions", {
    body: { email, code, device_name: "Test browser", client: "web", timezone: TZ },
    headers: { "accept-language": lang },
  });
  if (r.status !== 201) throw new Error("sign-in failed " + r.text);
  return { token: r.json.credential, deviceId: r.json.device.id, userId: r.json.user.id, email };
}

/**
 * Signs in with "always use my language" on: for tests about the account's language (or that count model calls and
 * must not be sent a second time for a language the account's own answer would have satisfied). The default is that
 * an analysis follows the language of the item itself, which the tests of that rule leave on.
 */
export async function signInMine(env: Env, email = "ann@example.com", lang: "en" | "zh" = "en"): Promise<Session> {
  const ann = await signIn(env, email, lang);
  const r = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: true } });
  if (r.status !== 200) throw new Error("switch failed " + r.text);
  return ann;
}

/** Connects another client with a short code, approved by a manage device. */
export async function connectDevice(env: Env, manager: Session, tier: "save" | "read" | "manage", client = "extension"): Promise<{ token: string; deviceId: string }> {
  const created = await call(env, "POST", "/v1/device-codes", { body: { device_name: `${tier} device`, client, requested_tier: tier } });
  const code = created.json.code;
  const approved = await call(env, "POST", `/v1/device-codes/${code}/approve`, { token: manager.token, body: {} });
  if (approved.status !== 200) throw new Error("approve failed " + approved.text);
  const polled = await call(env, "GET", `/v1/device-codes/${code}`, { token: created.json.poll_secret });
  return { token: polled.json.grant.credential, deviceId: polled.json.grant.device.id };
}

export interface Connected {
  access: string;
  refresh: string;
  assistantId: string;
  clientId: string;
  redirectUri: string;
}

/** The whole OAuth flow: register, authorize, allow on the allow page, exchange the code. */
export async function connectAssistant(
  env: Env,
  manager: Session,
  opts: { name: string; kind?: "scheduled" | "chat"; steps?: string[]; scope?: string } = { name: "Helper" },
): Promise<Connected> {
  const redirectUri = "https://assistant.example/callback";
  const reg = await call(env, "POST", "/oauth/register", { body: { client_name: "Test assistant", redirect_uris: [redirectUri] } });
  const clientId = reg.json.client_id;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "s1" });
  if (opts.scope) q.set("scope", opts.scope);
  const auth = await call(env, "GET", `/oauth/authorize?${q}`);
  if (auth.status !== 302) throw new Error("authorize failed " + auth.text);
  const requestId = new URL(auth.headers.get("location")!).searchParams.get("request")!;
  const decision = await call(env, "POST", `/v1/oauth/requests/${requestId}/decision`, {
    token: manager.token,
    body: { allow: true, name: opts.name, ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.steps ? { steps: opts.steps } : {}) },
  });
  if (decision.status !== 200) throw new Error("decision failed " + decision.text);
  const code = new URL(decision.json.redirect_to).searchParams.get("code")!;
  const tok = await call(env, "POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } });
  if (tok.status !== 200) throw new Error("token failed " + tok.text);
  const list = await call(env, "GET", "/v1/assistants", { token: manager.token });
  const assistantId = list.json.assistants.find((a: any) => a.name === opts.name).id;
  return { access: tok.json.access_token, refresh: tok.json.refresh_token, assistantId, clientId, redirectUri };
}

export async function saveText(env: Env, token: string, text: string, title?: string): Promise<string> {
  const r = await call(env, "POST", "/v1/items", { token, body: { kind: "text", text, ...(title ? { title } : {}) }, idem: idem() });
  if (r.status !== 201) throw new Error("save failed " + r.text);
  return r.json.item_id;
}

export async function rpc(env: Env, token: string | null, method: string, params?: unknown, id: number | null = 1): Promise<Reply> {
  return call(env, "POST", "/mcp", { token, body: { jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params === undefined ? {} : { params }) } });
}

export async function tool(env: Env, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; data: any; status?: number }> {
  const r = await rpc(env, token, "tools/call", { name, arguments: args });
  const result = r.json?.result;
  if (!result) throw new Error(`tools/call ${name} failed: ${r.status} ${r.text}`);
  return { isError: result.isError, data: result.structuredContent, status: result._meta?.status };
}

/** A stand-in for the model: answers every POST …/v1/messages with what `answer` returns. Never a real model. */
export function modelStub(answer: (request: any) => unknown, calls: any[] = []): Outbound {
  return async (url, init) => {
    if (!url.endsWith("/v1/messages")) return new Response("not stubbed: " + url, { status: 599 });
    const request = JSON.parse(String(init?.body));
    calls.push({ url, headers: init?.headers, request });
    const value = answer(request);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return Response.json({ id: "msg_test", type: "message", role: "assistant", model: request.model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 120, output_tokens: 40 } });
  };
}

export const LLM = { LLM_API_KEY: "test-model-key", LLM_BASE_URL: "https://model.test" };

export async function db(env: Env, sql: string, ...binds: unknown[]): Promise<any[]> {
  return (await env.DB.prepare(sql).bind(...binds).all()).results;
}

export { sha256Hex };

import { advance, HOUR, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";

/** Ann with a connected scheduled assistant that is the default for analysis, digest and deep read. */
export async function withHelper(env: Env, steps = ["analysis", "digest", "deep_read", "deep_dive"]): Promise<{ ann: Session; helper: Connected }> {
  const ann = await signIn(env);
  const helper = await connectAssistant(env, ann, { name: "Helper", kind: "scheduled", steps });
  const roles: Record<string, string> = {};
  for (const s of steps) roles[s] = helper.assistantId;
  const r = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles } });
  if (r.status !== 200) throw new Error("roles failed " + r.text);
  return { ann, helper };
}

/** Lets the 10 minutes pass after which the core gives waiting items their defaults. */
export async function coreTriage(env: Env): Promise<void> {
  advance(10 * MINUTE + 1000);
  await runMinute({ ...env, LLM_API_KEY: undefined });
}

export async function claim(env: Env, token: string, kind: string, limit?: number): Promise<any> {
  const r = await call(env, "POST", "/v1/assistant/claims", { token, body: { kind, ...(limit ? { limit } : {}) } });
  if (r.status !== 200) throw new Error("claim failed " + r.text);
  return r.json;
}

export function analysis(itemId: string, extra: Record<string, unknown> = {}) {
  return { kind: "analysis", item_id: itemId, summary: "A short note on brewing tea.", key_fact: "Text, 9 words", points: ["Cooler water for green tea."], verdict: "worth_deep_dive", ...extra };
}

export async function submit(env: Env, token: string, claimId: string, results: unknown[], usage?: unknown): Promise<Reply> {
  return call(env, "POST", `/v1/assistant/claims/${claimId}/submit`, { token, body: { results, ...(usage ? { usage } : {}) }, idem: idem() });
}

/** Saves texts, lets the core triage them, and has the helper analyse them all. Returns the item ids. */
export async function analysed(env: Env, ann: Session, helper: Connected, texts: string[], extra: Record<string, unknown> = {}): Promise<string[]> {
  const ids: string[] = [];
  for (const t of texts) ids.push(await saveText(env, ann.token, t));
  await coreTriage(env);
  const c = await claim(env, helper.access, "analysis");
  const r = await submit(env, helper.access, c.claim_id, c.work.map((w: any) => analysis(w.ref, extra)));
  if (r.status !== 200 || r.json.outcomes.some((o: any) => !o.accepted)) throw new Error("analysis failed " + r.text);
  return ids;
}

/** A model stand-in that answers the three built-in jobs by their system prompt. */
export function builtinModel(calls: any[] = [], overrides: { triage?: (input: any) => unknown; analysis?: (input: any) => unknown; digest?: (input: any) => unknown } = {}): Outbound {
  return modelStub((req) => {
    const content = req.messages[0].content;
    const input = JSON.parse(typeof content === "string" ? content : content.find((b: any) => b.type === "text").text);
    if (req.system.startsWith("You sort")) return overrides.triage ? overrides.triage(input) : input.items.map((i: any) => ({ item_id: i.item_id }));
    if (req.system.startsWith("You analyse")) {
      return overrides.analysis
        ? overrides.analysis(input)
        : { summary: `About: ${input.title}`.slice(0, 60), key_fact: "Text, short", points: ["First point.", "Second point."], verdict: "worth_deep_dive" };
    }
    return overrides.digest
      ? overrides.digest(input)
      : { summary: `You saved ${input.analyses.length} things today.`, worth: input.analyses.filter((a: any) => a.verdict === "worth_deep_dive").map((a: any) => ({ item_id: a.item_id, line: `Worth it: ${a.title}`.slice(0, 160) })), question: "What would you brew tomorrow?" };
  }, calls);
}

export const HOUR_MS = 60 * 60 * 1000;

/** The assistant renews its own credentials (they last an hour); no user involved. */
export async function refresh(env: Env, helper: Connected): Promise<void> {
  const r = await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh, client_id: helper.clientId } });
  if (r.status !== 200) throw new Error("refresh failed " + r.text);
  helper.access = r.json.access_token;
  helper.refresh = r.json.refresh_token;
}

/** Moves the clock far ahead while the device stays in use (a device idle for 90 days stops working). */
export async function leap(env: Env, session: Session, ms: number): Promise<void> {
  const step = 60 * 24 * HOUR_MS;
  for (let left = ms; left > 0; left -= step) {
    advance(Math.min(step, left));
    await call(env, "GET", "/v1/devices/me", { token: session.token });
  }
}

// ---------------------------------------------------------------- a full account, and what is left of one
// Shared by the operator's deletion (admin.test.ts) and the user's own (qa-25.test.ts).

export const PNG = (extra: number[]) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...extra]);

export async function sha(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Uploads a small picture and saves it as an item, so the file is referenced and stays. */
export async function saveImage(env: any, token: string, bytes: Uint8Array): Promise<string> {
  const up = await call(env, "POST", "/v1/assets", { token, body: { sha256: await sha(bytes), bytes: bytes.byteLength, content_type: "image/png" } });
  await call(env, "PUT", up.json.upload_url, { raw: bytes, headers: { "content-type": "image/png" } });
  const done = await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token });
  if (done.status !== 204) throw new Error("upload failed " + done.text);
  const saved = await call(env, "POST", "/v1/items", { token, body: { kind: "image", asset_id: up.json.asset_id }, idem: idem() });
  if (saved.status !== 201) throw new Error("image save failed " + saved.text);
  return up.json.asset_id;
}

export const MARKER = "ZEBRAQUARTZ";

/**
 * A user whose every kind of content carries MARKER: items (title and text), the analyses and the
 * daily digest the built-in assistants wrote from them, a note, and a queue entry.
 */
export async function filledUser(env: any, email = "ann@example.com"): Promise<{ user: Session; itemIds: string[] }> {
  const user = await signIn(env, email);
  const itemIds = [
    await saveText(env, user.token, `${MARKER} green tea wants cooler water.`, `${MARKER} tea`),
    await saveText(env, user.token, `Oolong sits in between. ${MARKER}`, `Oolong ${MARKER}`),
  ];
  await runMinute(env); // the built-in assistants triage and analyse
  advance(9 * HOUR + MINUTE); // 21:01 in the user's time zone
  await runMinute(env); // the daily digest
  const note = await call(env, "POST", "/v1/notes", { token: user.token, body: { title: `${MARKER} note`, body: `What I learnt: ${MARKER}.`, item_id: itemIds[0] }, idem: idem() });
  if (note.status !== 201) throw new Error("note failed " + note.text);
  await call(env, "PUT", `/v1/deep-read-queue/${itemIds[1]}`, { token: user.token });
  return { user, itemIds };
}

/** Every table that has a user_id column, found by asking each table — not by the list the core keeps. */
export async function tablesWithUserId(env: any): Promise<string[]> {
  const names = (await db(env, "SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name as string);
  const out: string[] = [];
  for (const name of names) {
    if (/^(sqlite_|_cf_|d1_)/i.test(name) || name === "users") continue;
    try {
      await db(env, `SELECT COUNT(*) AS n FROM "${name}" WHERE user_id = ?`, "nobody");
      out.push(name);
    } catch {
      // no such column: not a table with user data
    }
  }
  return out.sort();
}

/** Puts a row for the user into every user table that has none yet, built from the table's own columns. */
export async function fillEmptyTables(env: any, tables: string[], userId: string): Promise<string[]> {
  const filled: string[] = [];
  for (const table of tables) {
    if ((await db(env, `SELECT COUNT(*) AS n FROM "${table}" WHERE user_id = ?`, userId))[0].n > 0) continue;
    const columns = await db(env, `PRAGMA table_info("${table}")`);
    const values = columns.map((c: any) => (c.name === "user_id" ? userId : /INT/i.test(c.type) ? 1 : `fill-${userId}-${table}-${c.name}`));
    await db(env, `INSERT INTO "${table}" (${columns.map((c: any) => `"${c.name}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, ...values);
    filled.push(table);
  }
  return filled;
}

