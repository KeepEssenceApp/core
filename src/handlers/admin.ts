// The operator (admin) interface. Not part of the contract; described in docs/admin-api.md.
// Every route is behind ADMIN_SECRET and answers 404 when that secret is not set.
//
// Two rules hold for everything in this file:
// - No content: no title, body, address or text of an item, analysis, daily digest or note ever
//   leaves through these routes. Only counts, times, and the names of devices and assistants.
// - Few queries: every list is one aggregating statement or one batch, never a loop over users.
import { loadFetchSettings, PROVIDERS, runProvider, saveFetchSettings, usable, validEndpoint, type FetchSettings, type ProviderId, type TestResult } from "../services/fetchers";
import { isPublicUrl } from "../services/fetchpage";
import { forwardingConfigured, type FeedbackRow } from "./feedback";
import pkg from "../../package.json";
import { DAY, now } from "../clock";
import { CRON_KEYS } from "../cron";
import type { Env } from "../env";
import { err } from "../errors";
import { releaseAllClaimsStatements } from "../services/accounts";
import { DEFAULT_MODEL } from "../services/model";
import { likePattern } from "../services/work";
import { addDays, localDay } from "../time";
import { b64url, fromB64url, iso, newId, parseJson, safeEqual } from "../util";
import { mailConfigured, mintLoginCode, normalEmail } from "./signin";

type Params = Record<string, string>;
type AdminHandler = (env: Env, request: Request, params: Params) => Promise<Response>;

export interface AdminRoute {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  why: string;
  handler: AdminHandler;
}

// ---------------------------------------------------------------- guard and small helpers

async function requireAdmin(env: Env, request: Request): Promise<void> {
  if (!env.ADMIN_SECRET) throw err("not_found");
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || !(await safeEqual(m[1].trim(), env.ADMIN_SECRET))) throw err("unauthorized");
}

/** The only way a route is run: the guard comes first, whatever the route does. */
export async function runAdmin(route: AdminRoute, env: Env, request: Request, params: Params): Promise<Response> {
  await requireAdmin(env, request);
  return route.handler(env, request, params);
}

const NO_STORE = { "cache-control": "no-store" };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw err("bad_request", "请求内容不是合法的 JSON。", "The request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw err("bad_request", "请求内容应为 JSON 对象。", "The request body must be a JSON object.");
  return body as Record<string, unknown>;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validEmail(email: string): boolean {
  return EMAIL.test(email) && email.length <= 254;
}

function emailOf(body: Record<string, unknown>, field = "email"): string {
  const email = typeof body[field] === "string" ? normalEmail(body[field] as string) : "";
  if (!validEmail(email)) throw err("bad_request", `需要一个邮箱地址：{"${field}": "…"}。`, `An email address is needed: {"${field}": "…"}.`);
  return email;
}

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

function limitOf(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return LIMIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw err("bad_request", "limit 应为 1 到 200 的整数。", "limit must be an integer from 1 to 200.");
  return Math.min(n, LIMIT_MAX);
}

function badCursor() {
  return err("bad_request", "cursor 无效。", "The cursor is not valid.");
}

function encodeCursor(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

function decodeCursor(cursor: string): string {
  try {
    return new TextDecoder().decode(fromB64url(cursor));
  } catch {
    throw badCursor();
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function utcDayStart(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// ---------------------------------------------------------------- audit log

type AuditAction =
  | "invite.add"
  | "invite.remove"
  | "login_code.mint"
  | "user.suspend"
  | "user.restore"
  | "user.sign_out"
  | "user.device_revoke"
  | "user.delete"
  | "user.delete_self"
  | "fetch.settings";

/** One audit entry written by the core. `detail` is built here from names and counts only: never a code or a credential. */
function auditStatement(env: Env, action: AuditAction, target: string, detail = ""): D1PreparedStatement {
  return env.DB.prepare("INSERT INTO admin_audit (id, at, action, target, detail, source) VALUES (?, ?, ?, ?, ?, 'core')").bind(
    newId("aud"),
    now(),
    action,
    target,
    detail,
  );
}

interface AuditRow {
  seq: number;
  id: string;
  at: number;
  action: string;
  target: string;
  detail: string;
  source: string;
}

function auditView(r: AuditRow) {
  return { id: r.id, at: iso(r.at), action: r.action, target: r.target, detail: r.detail, source: r.source };
}

const listAudit: AdminHandler = async (env, request) => {
  const url = new URL(request.url);
  const limit = limitOf(url);
  const cursor = url.searchParams.get("cursor");
  let before = Number.MAX_SAFE_INTEGER;
  if (cursor) {
    before = Number(decodeCursor(cursor));
    if (!Number.isInteger(before) || before < 1) throw badCursor();
  }
  const rows = await env.DB.prepare("SELECT seq, id, at, action, target, detail, source FROM admin_audit WHERE seq < ? ORDER BY seq DESC LIMIT ?")
    .bind(before, limit + 1)
    .all<AuditRow>();
  const page = rows.results.slice(0, limit);
  return json({
    entries: page.map(auditView),
    next_cursor: rows.results.length > limit ? encodeCursor(String(page[page.length - 1].seq)) : null,
  });
};

// ---------------------------------------------------------------- reading saved links

const STATS_DAYS = 7;

/** What the portal shows: every setting except the keys themselves (only whether one is set, and its last four characters). */
async function fetchView(env: Env, s: FetchSettings) {
  const since = new Date(now() - (STATS_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await env.DB.prepare("SELECT platform, path, SUM(n) AS n FROM fetch_stats WHERE day >= ? GROUP BY platform, path ORDER BY platform, path")
    .bind(since)
    .all<{ platform: string; path: string; n: number }>();
  const provider = (id: "jina" | "firecrawl") => ({
    enabled: s[id].enabled,
    endpoint: s[id].endpoint,
    key_set: s[id].key !== "",
    key_hint: s[id].key.length >= 12 ? `…${s[id].key.slice(-4)}` : "",
  });
  const test = (id: ProviderId) => {
    const r = s.tests[id];
    return r ? { at: iso(r.at), url_host: r.url_host, ok: r.ok, chars: r.chars, ms: r.ms, error: r.error } : null;
  };
  return {
    order: s.order,
    jina: provider("jina"),
    firecrawl: provider("firecrawl"),
    tests: { direct: test("direct"), jina: test("jina"), firecrawl: test("firecrawl") },
    stats: { days: STATS_DAYS, rows: rows.results },
  };
}

const getFetch: AdminHandler = async (env) => json(await fetchView(env, await loadFetchSettings(env)));

/** Changes take effect at the next link that is read. A key is write-only: sent to set it, `""` to clear it, left out to keep it. */
const putFetch: AdminHandler = async (env, request) => {
  const b = (await readBody(request)) as { order?: unknown; jina?: Record<string, unknown>; firecrawl?: Record<string, unknown> };
  const s = await loadFetchSettings(env);
  const bad = (zh: string, en: string) => err("bad_request", zh, en);
  if (b.order !== undefined) {
    const order = b.order;
    if (!Array.isArray(order) || order.length !== PROVIDERS.length || !PROVIDERS.every((p) => order.includes(p))) throw bad("顺序要正好包含三种方式各一次。", "The order must name each of the three ways exactly once.");
    s.order = order as ProviderId[];
  }
  const changed: string[] = [];
  for (const id of ["jina", "firecrawl"] as const) {
    const p = b[id];
    if (p === undefined) continue;
    if (typeof p !== "object" || p === null) throw bad("格式不对。", "Malformed.");
    if (p.enabled !== undefined) {
      if (typeof p.enabled !== "boolean") throw bad("格式不对。", "Malformed.");
      if (p.enabled !== s[id].enabled) changed.push(`${id} ${p.enabled ? "on" : "off"}`);
      s[id].enabled = p.enabled;
    }
    if (p.endpoint !== undefined) {
      if (typeof p.endpoint !== "string" || p.endpoint.length > 300 || !validEndpoint(p.endpoint.trim())) throw bad("地址要以 https:// 开头，不带账号、参数。", "The address must start with https:// and hold no credentials or query.");
      if (p.endpoint.trim() !== s[id].endpoint) changed.push(`${id} endpoint`);
      s[id].endpoint = p.endpoint.trim();
    }
    if (p.key !== undefined) {
      if (typeof p.key !== "string" || p.key.length > 400) throw bad("格式不对。", "Malformed.");
      if (p.key.trim() !== s[id].key) changed.push(`${id} key ${p.key.trim() ? "set" : "cleared"}`);
      s[id].key = p.key.trim();
    }
  }
  if (b.order !== undefined) changed.push(`order ${s.order.join(" > ")}`);
  await saveFetchSettings(env, s);
  if (changed.length) await auditStatement(env, "fetch.settings", "fetch", changed.join("; ")).run();
  return json(await fetchView(env, s));
};

/** Reads one address with one way, now, and remembers how it went (never what it read). */
const testFetch: AdminHandler = async (env, request) => {
  const b = (await readBody(request)) as { provider?: unknown; url?: unknown };
  if (typeof b.provider !== "string" || !PROVIDERS.includes(b.provider as ProviderId) || typeof b.url !== "string" || !isPublicUrl(b.url)) {
    throw err("bad_request", "要给一种方式和一个公开的网址。", "Give one of the ways and a public address.");
  }
  const id = b.provider as ProviderId;
  const s = await loadFetchSettings(env);
  const started = Date.now();
  let result: TestResult;
  let title = "";
  try {
    const page = await runProvider(env, id, s, b.url);
    title = page.title;
    const chars = page.text.replace(/\s+/g, "").length;
    result = { at: now(), url_host: new URL(b.url).hostname, ok: usable(page), chars, ms: Date.now() - started, error: usable(page) ? "" : "only a page shell came back" };
  } catch (e) {
    result = { at: now(), url_host: new URL(b.url).hostname, ok: false, chars: 0, ms: Date.now() - started, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
  const latest = await loadFetchSettings(env);
  latest.tests[id] = result;
  await saveFetchSettings(env, latest);
  return json({ provider: id, ok: result.ok, chars: result.chars, ms: result.ms, error: result.error, title: title.slice(0, 200) });
};

// ---------------------------------------------------------------- feedback

/**
 * What users wrote to the operator. This is the one list here that holds text a user typed:
 * they addressed it to the operator. It never holds anything of an item, analysis, digest or note.
 */
const listFeedback: AdminHandler = async (env, request) => {
  const url = new URL(request.url);
  const limit = limitOf(url);
  const cursor = url.searchParams.get("cursor");
  let before = Number.MAX_SAFE_INTEGER;
  if (cursor) {
    before = Number(decodeCursor(cursor));
    if (!Number.isInteger(before) || before < 1) throw badCursor();
  }
  const rows = await env.DB.prepare("SELECT rowid AS seq, * FROM feedback WHERE rowid < ? ORDER BY rowid DESC LIMIT ?").bind(before, limit + 1).all<FeedbackRow>();
  const page = rows.results.slice(0, limit);
  return json({
    forwarding: forwardingConfigured(env) ? env.FEEDBACK_GITHUB_REPO : null,
    feedback: page.map((r) => ({
      id: r.id,
      at: iso(r.created_at),
      user_id: r.user_id,
      email: r.email,
      client: r.client,
      where: r.place,
      doing: r.doing,
      wrong: r.wrong,
      wish: r.wish,
      issue_url: r.issue_url,
      forward_error: r.issue_url ? null : r.forward_error,
    })),
    next_cursor: rows.results.length > limit ? encodeCursor(String(page[page.length - 1].seq)) : null,
  });
};

/** Something that looks like one of the core's credentials (device, access, refresh, one-time code). */
const CREDENTIAL = /\bk[dacr]_[A-Za-z0-9_-]{16,}/;

/** For what the portal does itself (signing in, inviting from the waitlist). */
const addAudit: AdminHandler = async (env, request) => {
  const body = await readBody(request);
  const text = (field: string, max: number, required: boolean): string => {
    const value = body[field];
    if (value === undefined || value === null) {
      if (required) throw err("bad_request", `缺少 ${field}。`, `${field} is missing.`);
      return "";
    }
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
      throw err("bad_request", `${field} 应为不超过 ${max} 个字符的文字。`, `${field} must be text of at most ${max} characters.`);
    }
    return value.trim();
  };
  const action = text("action", 64, true);
  if (!/^[a-z][a-z0-9_.:-]*$/.test(action)) {
    throw err("bad_request", "action 只能用小写字母、数字和 . _ : -。", "action may only hold lower-case letters, digits and . _ : -");
  }
  const target = text("target", 320, false);
  const detail = text("detail", 1000, false);
  if (CREDENTIAL.test(target) || CREDENTIAL.test(detail)) {
    throw err("bad_request", "记录里不能放凭据。", "An audit entry must not hold a credential.");
  }
  const row = await env.DB.prepare(
    "INSERT INTO admin_audit (id, at, action, target, detail, source) VALUES (?, ?, ?, ?, ?, 'portal') RETURNING seq, id, at, action, target, detail, source",
  )
    .bind(newId("aud"), now(), action, target, detail)
    .first<AuditRow>();
  return json(auditView(row!), 201);
};

// ---------------------------------------------------------------- overview

const getOverview: AdminHandler = async (env) => {
  const t = now();
  const today = utcDayStart(t);
  const week = t - 7 * DAY;
  const active = "NOT IN (SELECT id FROM users WHERE suspended_at IS NOT NULL)";
  const windowed = (table: string) =>
    env.DB.prepare(`SELECT COUNT(*) AS last_7d, COALESCE(SUM(created_at >= ?1), 0) AS today FROM ${table} WHERE created_at >= ?2`).bind(today, Math.min(week, today));
  const [users, active7d, invites, items, live, analyses, digests, notes, waiting, usage, state] = await env.DB.batch<any>([
    env.DB.prepare("SELECT COUNT(*) AS total, COUNT(suspended_at) AS suspended FROM users"),
    env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM devices WHERE last_used_at >= ?").bind(week),
    env.DB.prepare(
      "SELECT COUNT(*) AS total, COALESCE(SUM(NOT EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)), 0) AS pending FROM invites i",
    ),
    windowed("items"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE archived_at IS NULL"),
    windowed("analyses"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM digests WHERE status = 'done' AND created_at >= ?").bind(week),
    env.DB.prepare("SELECT COUNT(*) AS n FROM notes"),
    // What the cron work will get to: the items of suspended accounts are left out, nobody works on them.
    env.DB.prepare(
      `SELECT COALESCE(SUM(triaged_at IS NULL), 0) AS triage, COALESCE(SUM(triaged_at IS NOT NULL), 0) AS analysis
       FROM items WHERE analysed_at IS NULL AND archived_at IS NULL AND user_id ${active}`,
    ),
    env.DB.prepare(
      `SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(CASE WHEN created_at >= ?1 THEN calls END), 0) AS today_calls,
              COALESCE(SUM(CASE WHEN created_at >= ?1 THEN input_tokens END), 0) AS today_input_tokens,
              COALESCE(SUM(CASE WHEN created_at >= ?1 THEN output_tokens END), 0) AS today_output_tokens
       FROM usage_records WHERE self_reported = 0 AND created_at >= ?2`,
    ).bind(today, Math.min(week, today)),
    env.DB.prepare("SELECT key, value, updated_at FROM core_state WHERE key IN (?, ?, 'mail.last')").bind(CRON_KEYS.minute, CRON_KEYS.hourly),
  ]);
  const one = (r: { results: any[] }) => r.results[0] ?? {};
  const ranAt = (key: string): string | null => {
    const row = state.results.find((s: any) => s.key === key);
    const ms = row ? Number(row.value) : NaN;
    return Number.isFinite(ms) ? iso(ms) : null;
  };
  const u = one(usage);
  // The outcome of the last sign-in mail: "sent", or why it failed. Never an address or a code.
  const mailRow = state.results.find((r: any) => r.key === "mail.last") as { value: string; updated_at: number } | undefined;
  const mailLast = mailRow ? { at: iso(Number(mailRow.updated_at)), result: String(mailRow.value).slice(0, 200) } : null;
  return json({
    users: { total: one(users).total ?? 0, active_7d: one(active7d).n ?? 0, suspended: one(users).suspended ?? 0 },
    invites: { total: one(invites).total ?? 0, pending: one(invites).pending ?? 0 },
    items: { today: one(items).today ?? 0, last_7d: one(items).last_7d ?? 0, live: one(live).n ?? 0 },
    analyses: { today: one(analyses).today ?? 0, last_7d: one(analyses).last_7d ?? 0 },
    digests: { last_7d: one(digests).n ?? 0 },
    notes: { total: one(notes).n ?? 0 },
    waiting: { triage: one(waiting).triage ?? 0, analysis: one(waiting).analysis ?? 0 },
    usage: {
      today: { calls: u.today_calls ?? 0, input_tokens: u.today_input_tokens ?? 0, output_tokens: u.today_output_tokens ?? 0 },
      last_7d: { calls: u.calls ?? 0, input_tokens: u.input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 },
    },
    cron: { minute_ran_at: ranAt(CRON_KEYS.minute), hourly_ran_at: ranAt(CRON_KEYS.hourly) },
    config: {
      model: env.LLM_MODEL || DEFAULT_MODEL,
      model_configured: Boolean(env.LLM_API_KEY),
      mail_configured: mailConfigured(env),
      feedback_forwarding: forwardingConfigured(env),
      mail_last: mailLast,
      push_configured: Boolean(env.VAPID_PRIVATE_KEY && env.VAPID_PUBLIC_KEY),
      version: env.CORE_VERSION || pkg.version,
    },
  });
};

// ---------------------------------------------------------------- invitations

const listInvites: AdminHandler = async (env) => {
  const rows = await env.DB.prepare(
    `SELECT i.email, i.created_at AS invited_at, u.created_at AS joined_at, u.id AS user_id
     FROM invites i LEFT JOIN users u ON u.email = i.email ORDER BY i.created_at DESC, i.rowid DESC`,
  ).all<{ email: string; invited_at: number; joined_at: number | null; user_id: string | null }>();
  return json({
    invites: rows.results.map((r) => ({ email: r.email, invited_at: iso(r.invited_at), joined_at: iso(r.joined_at), user_id: r.user_id })),
  });
};

const INVITES_MAX = 1000;

const addInvites: AdminHandler = async (env, request) => {
  const body = await readBody(request);
  const single = typeof body.email === "string";
  const given: unknown[] = [...(single ? [body.email] : []), ...(Array.isArray(body.emails) ? body.emails : [])];
  if (given.length === 0 || (body.emails !== undefined && !Array.isArray(body.emails))) {
    throw err("bad_request", '需要 {"email": "…"} 或 {"emails": ["…"]}。', 'Either {"email": "…"} or {"emails": ["…"]} is needed.');
  }
  if (given.length > INVITES_MAX) throw err("bad_request", `一次最多 ${INVITES_MAX} 个邮箱。`, `At most ${INVITES_MAX} emails at a time.`);
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const entry of given) {
    const email = typeof entry === "string" ? normalEmail(entry) : "";
    if (validEmail(email)) {
      if (!valid.includes(email)) valid.push(email);
    } else {
      const shown = (typeof entry === "string" ? entry.trim() : JSON.stringify(entry) ?? "").slice(0, 254);
      if (!invalid.includes(shown)) invalid.push(shown);
    }
  }
  let added: string[] = [];
  if (valid.length > 0) {
    // One statement however many addresses: only the ones that were not on the list come back.
    const inserted = await env.DB.prepare("INSERT OR IGNORE INTO invites (email, created_at) SELECT value, ?2 FROM json_each(?1) RETURNING email")
      .bind(JSON.stringify(valid), now())
      .all<{ email: string }>();
    const fresh = new Set(inserted.results.map((r) => r.email));
    added = valid.filter((e) => fresh.has(e));
    if (added.length > 0) {
      await env.DB.prepare(
        `INSERT INTO admin_audit (id, at, action, target, detail, source)
         SELECT 'aud_' || lower(hex(randomblob(12))), ?2, 'invite.add', value, '', 'core' FROM json_each(?1)`,
      )
        .bind(JSON.stringify(added), now())
        .run();
    }
  }
  const already = valid.filter((e) => !added.includes(e));
  // `email` is what this route answered before the lists were added; kept for the single form.
  return json({ ...(single && valid.length > 0 ? { email: valid[0] } : {}), added, already, invalid }, 201);
};

/** The address can no longer sign in. An account that already exists is not touched. */
const removeInvite: AdminHandler = async (env, request) => {
  const email = emailOf(await readBody(request));
  const [removed] = await env.DB.batch([
    env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(email),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(email),
  ]);
  if ((removed.meta.changes ?? 0) > 0) await auditStatement(env, "invite.remove", email).run();
  return noContent();
};

/** Mints a code for an invited address and returns it once, so the operator can pass it on. */
const mintCode: AdminHandler = async (env, request) => {
  const email = emailOf(await readBody(request));
  const row = await env.DB.prepare("SELECT (SELECT suspended_at FROM users WHERE email = ?1) AS suspended_at FROM invites WHERE email = ?1")
    .bind(email)
    .first<{ suspended_at: number | null }>();
  if (!row) throw err("not_invited");
  if (row.suspended_at !== null) throw err("conflict", "这个账户已停用，不能登录。", "This account is suspended and cannot sign in.");
  const { code, expiresAt } = await mintLoginCode(env, email);
  // The entry says that a code was minted and for whom. The code itself is never written anywhere in the clear.
  await auditStatement(env, "login_code.mint", email).run();
  return json({ email, code, expires_at: iso(expiresAt) }, 201);
};

// ---------------------------------------------------------------- users

interface AdminUserRow {
  id: string;
  email: string;
  created_at: number;
  suspended_at: number | null;
  lang: string;
  timezone: string;
  storage_bytes: number;
  last_active_at: number | null;
  devices: number;
  assistants: number;
  items_live: number;
  notes: number;
}

/** One row per account, counts included, in one statement. The hidden dispatch assistant is not counted. */
const USER_SELECT = `
  SELECT u.id, u.email, u.created_at, u.suspended_at, u.lang, u.timezone, u.storage_bytes,
    (SELECT MAX(d.last_used_at) FROM devices d WHERE d.user_id = u.id) AS last_active_at,
    (SELECT COUNT(*) FROM devices d WHERE d.user_id = u.id AND d.revoked_at IS NULL) AS devices,
    (SELECT COUNT(*) FROM assistants a WHERE a.user_id = u.id AND a.revoked_at IS NULL AND (a.built_in IS NULL OR a.built_in <> 'dispatch')) AS assistants,
    (SELECT COUNT(*) FROM items i WHERE i.user_id = u.id AND i.archived_at IS NULL) AS items_live,
    (SELECT COUNT(*) FROM notes n WHERE n.user_id = u.id) AS notes
  FROM users u`;

function userRowView(r: AdminUserRow) {
  return {
    id: r.id,
    email: r.email,
    created_at: iso(r.created_at),
    last_active_at: iso(r.last_active_at),
    status: r.suspended_at === null ? ("active" as const) : ("suspended" as const),
    lang: r.lang,
    timezone: r.timezone,
    devices: r.devices,
    assistants: r.assistants,
    items_live: r.items_live,
    notes: r.notes,
    storage_bytes: r.storage_bytes,
  };
}

async function loadUser(env: Env, id: string): Promise<AdminUserRow> {
  const row = await env.DB.prepare(`${USER_SELECT} WHERE u.id = ?`).bind(id).first<AdminUserRow>();
  if (!row) throw err("not_found");
  return row;
}

const listUsers: AdminHandler = async (env, request) => {
  const url = new URL(request.url);
  const limit = limitOf(url);
  const where: string[] = [];
  const binds: unknown[] = [];
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q) {
    where.push("u.email LIKE ? ESCAPE '\\'");
    binds.push(likePattern(q));
  }
  const status = url.searchParams.get("status") ?? "";
  if (status === "active") where.push("u.suspended_at IS NULL");
  else if (status === "suspended") where.push("u.suspended_at IS NOT NULL");
  else if (status !== "") throw err("bad_request", "status 只能是 active 或 suspended。", "status must be active or suspended.");
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const [at, id] = decodeCursor(cursor).split("|");
    if (!Number.isInteger(Number(at)) || !id) throw badCursor();
    where.push("(u.created_at < ? OR (u.created_at = ? AND u.id < ?))");
    binds.push(Number(at), Number(at), id);
  }
  const rows = await env.DB.prepare(`${USER_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY u.created_at DESC, u.id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<AdminUserRow>();
  const page = rows.results.slice(0, limit);
  const last = page[page.length - 1];
  return json({ users: page.map(userRowView), next_cursor: rows.results.length > limit ? encodeCursor(`${last.created_at}|${last.id}`) : null });
};

const DETAIL_DAYS = 30;

const getUserDetail: AdminHandler = async (env, _request, params) => {
  const user = await loadUser(env, params.id);
  const today = localDay(now(), user.timezone);
  const from = addDays(today, -(DETAIL_DAYS - 1));
  const [devices, pushes, assistants, counts, usage] = await env.DB.batch<any>([
    env.DB.prepare("SELECT id, name, client, tier, created_at, last_used_at FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, id").bind(user.id),
    env.DB.prepare("SELECT device_id FROM push_targets WHERE user_id = ?").bind(user.id),
    env.DB.prepare(
      `SELECT id, name, kind, built_in, steps, connected_at, last_seen_at FROM assistants
       WHERE user_id = ? AND revoked_at IS NULL AND (built_in IS NULL OR built_in <> 'dispatch') ORDER BY connected_at, id`,
    ).bind(user.id),
    env.DB.prepare(
      "SELECT day, SUM(saved) AS saved, SUM(analysed) AS analysed, SUM(digests) AS digests, SUM(notes) AS notes FROM daily_counts WHERE user_id = ? AND day BETWEEN ? AND ? GROUP BY day",
    ).bind(user.id, from, today),
    // Every assistant that did work, the hidden dispatch assistant and disconnected ones included.
    env.DB.prepare(
      `SELECT r.assistant_id, a.name, a.built_in, SUM(r.calls) AS calls, SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens, SUM(r.items) AS items
       FROM usage_records r LEFT JOIN assistants a ON a.id = r.assistant_id AND a.user_id = r.user_id
       WHERE r.user_id = ? AND r.created_at >= ? GROUP BY r.assistant_id ORDER BY a.connected_at, a.built_in IS NULL, a.built_in, r.assistant_id`,
    ).bind(user.id, now() - DETAIL_DAYS * DAY),
  ]);
  const withPush = new Set(pushes.results.map((p: any) => p.device_id));
  const byDay = new Map<string, any>(counts.results.map((c: any) => [c.day, c]));
  const days = [];
  for (let i = 0; i < DETAIL_DAYS; i++) {
    const day = addDays(from, i);
    const c = byDay.get(day);
    days.push({ day, saved: c?.saved ?? 0, analysed: c?.analysed ?? 0, digests: c?.digests ?? 0, notes: c?.notes ?? 0 });
  }
  return json({
    ...userRowView(user),
    suspended_at: iso(user.suspended_at),
    devices: devices.results.map((d: any) => ({
      id: d.id,
      name: d.name,
      client: d.client,
      tier: d.tier,
      created_at: iso(d.created_at),
      last_used_at: iso(d.last_used_at),
      notifications: withPush.has(d.id),
    })),
    assistants: assistants.results.map((a: any) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      built_in: a.built_in !== null,
      steps: parseJson<string[]>(a.steps, []),
      connected_at: iso(a.connected_at),
      last_seen_at: iso(a.last_seen_at),
    })),
    days,
    usage: usage.results.map((r: any) => ({
      assistant_id: r.assistant_id,
      name: r.name ?? "",
      built_in: r.built_in !== null && r.built_in !== undefined,
      calls: r.calls,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      items: r.items,
    })),
  });
};

/**
 * From this moment nothing of the account works: every credential is refused where it is checked
 * (services/accounts.ts), sign-in is closed, the cron work passes the account by. Nothing is
 * deleted or revoked, so restoring brings everything back as it was. What its assistants had
 * claimed goes back in the same batch.
 */
const suspendUser: AdminHandler = async (env, _request, params) => {
  const user = await loadUser(env, params.id);
  if (user.suspended_at !== null) return json(userRowView(user));
  const t = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ? AND suspended_at IS NULL").bind(t, user.id),
    ...releaseAllClaimsStatements(env, user.id),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(user.email),
    auditStatement(env, "user.suspend", user.id, user.email),
  ]);
  return json(userRowView({ ...user, suspended_at: t }));
};

const restoreUser: AdminHandler = async (env, _request, params) => {
  const user = await loadUser(env, params.id);
  if (user.suspended_at === null) return json(userRowView(user));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET suspended_at = NULL WHERE id = ?").bind(user.id),
    auditStatement(env, "user.restore", user.id, user.email),
  ]);
  return json(userRowView({ ...user, suspended_at: null }));
};

/** Revokes every client device. Assistants are not touched; the user can sign in again. */
const signOutUser: AdminHandler = async (env, _request, params) => {
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(params.id).first<{ id: string; email: string }>();
  if (!user) throw err("not_found");
  const res = await env.DB.batch([
    // First, while the devices still count as live: the entry says how many were signed out.
    env.DB.prepare(
      `INSERT INTO admin_audit (id, at, action, target, detail, source)
       SELECT ?1, ?2, 'user.sign_out', ?3, ?4 || '; devices: ' || COUNT(*), 'core' FROM devices WHERE user_id = ?3 AND revoked_at IS NULL`,
    ).bind(newId("aud"), now(), user.id, user.email),
    env.DB.prepare("UPDATE devices SET revoked_at = ?, credential_hash = NULL WHERE user_id = ? AND revoked_at IS NULL").bind(now(), user.id),
    env.DB.prepare("DELETE FROM push_targets WHERE user_id = ?").bind(user.id),
  ]);
  return json({ revoked: res[1].meta.changes ?? 0 });
};

const revokeUserDevice: AdminHandler = async (env, _request, params) => {
  const row = await env.DB.prepare(
    `SELECT u.email, d.id AS device_id, d.name, d.revoked_at FROM users u
     LEFT JOIN devices d ON d.user_id = u.id AND d.id = ?2 WHERE u.id = ?1`,
  )
    .bind(params.id, params.device_id)
    .first<{ email: string; device_id: string | null; name: string | null; revoked_at: number | null }>();
  if (!row || !row.device_id) throw err("not_found");
  if (row.revoked_at !== null) return noContent(); // already revoked: nothing to do, nothing to record
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET revoked_at = ?, credential_hash = NULL WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(now(), row.device_id, params.id),
    env.DB.prepare("DELETE FROM push_targets WHERE device_id = ? AND user_id = ?").bind(row.device_id, params.id),
    auditStatement(env, "user.device_revoke", params.id, `${row.email}; device ${row.device_id} (${row.name ?? ""})`),
  ]);
  return noContent();
};

// ---------------------------------------------------------------- deleting an account

/** Rows removed per table and round, and how many rounds before the rest goes in one last statement per table. */
const DELETE_CHUNK = 500;
const DELETE_ROUNDS_MAX = 20;
const R2_PAGE = 1000;

/**
 * Every table that has a `user_id` column, read from the schema itself, so a table added by a
 * later migration is covered without anyone remembering to list it here. Virtual tables (the
 * notes index) are included; their shadow tables and SQLite's and D1's own tables are not.
 */
export async function userTables(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all<{ name: string; sql: string | null }>();
  return rows.results
    .filter((r) => /^[A-Za-z][A-Za-z0-9_]*$/.test(r.name) && !/^(sqlite_|_cf_|d1_)/i.test(r.name) && r.name !== "users")
    .filter((r) => /\buser_id\b/.test((r.sql ?? "").replace(/--[^\n]*/g, "")))
    .map((r) => r.name)
    .sort();
}

/**
 * Removes the account and everything it owns. Order matters for a run that is cut short:
 * 1. the account is suspended, so nothing can write for it while it is being removed;
 * 2. its rows go, table by table, a bounded number per statement;
 * 3. its files in R2 go (everything under `u/{user_id}/`);
 * 4. one last batch removes whatever is left, the account itself, its invitation and its codes,
 *    and writes the audit entry.
 * Until step 4 the account still exists (suspended), so the same request can simply be sent again.
 * The one way an account is deleted: the operator's route below and the user's own
 * `DELETE /v1/account` (handlers/account.ts) both end here; `by` only chooses the audit entry.
 */
export async function deleteAccount(env: Env, user: { id: string; email: string }, by: "operator" | "user" = "operator"): Promise<void> {
  await env.DB.prepare("UPDATE users SET suspended_at = COALESCE(suspended_at, ?) WHERE id = ?").bind(now(), user.id).run();
  const tables = await userTables(env);
  for (let round = 0; round < DELETE_ROUNDS_MAX; round++) {
    const res = await env.DB.batch(
      tables.map((t) => env.DB.prepare(`DELETE FROM "${t}" WHERE rowid IN (SELECT rowid FROM "${t}" WHERE user_id = ? LIMIT ${DELETE_CHUNK})`).bind(user.id)),
    );
    if (res.every((r) => (r.meta.changes ?? 0) < DELETE_CHUNK)) break;
  }
  const prefix = `u/${user.id}/`;
  for (;;) {
    const page = await env.FILES.list({ prefix, limit: R2_PAGE });
    if (page.objects.length > 0) await env.FILES.delete(page.objects.map((o) => o.key));
    if (!page.truncated || page.objects.length === 0) break;
  }
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM "${t}" WHERE user_id = ?`).bind(user.id)),
    env.DB.prepare("DELETE FROM login_codes WHERE email = ?").bind(user.email),
    env.DB.prepare("DELETE FROM invites WHERE email = ?").bind(user.email),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    // The operator's entry says who it was. The user's own deletion leaves the id and nothing else.
    by === "user" ? auditStatement(env, "user.delete_self", user.id) : auditStatement(env, "user.delete", user.id, user.email),
  ]);
}

const deleteUser: AdminHandler = async (env, request, params) => {
  const body = await readBody(request);
  const user = await env.DB.prepare("SELECT id, email FROM users WHERE id = ?").bind(params.id).first<{ id: string; email: string }>();
  if (!user) throw err("not_found");
  const confirm = typeof body.confirm_email === "string" ? normalEmail(body.confirm_email) : "";
  if (confirm !== user.email) {
    throw err("bad_request", "confirm_email 和这个账户的邮箱不一致，没有删除。", "confirm_email does not match the email of this account. Nothing was deleted.");
  }
  await deleteAccount(env, user);
  return noContent();
};

// ---------------------------------------------------------------- usage

const getUsage: AdminHandler = async (env, request) => {
  const raw = new URL(request.url).searchParams.get("days");
  const days = raw === null || raw === "" ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 90) throw err("bad_request", "days 应为 1 到 90 的整数。", "days must be an integer from 1 to 90.");
  const today = utcDay(now());
  const from = addDays(today, -(days - 1));
  const since = Date.parse(from + "T00:00:00Z");
  const [perDay, top] = await env.DB.batch<any>([
    env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, SUM(calls) AS calls, SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens, SUM(items) AS items
       FROM usage_records WHERE self_reported = 0 AND created_at >= ? GROUP BY day`,
    ).bind(since),
    env.DB.prepare(
      `SELECT r.user_id, u.email, SUM(r.calls) AS calls, SUM(r.input_tokens) AS input_tokens, SUM(r.output_tokens) AS output_tokens
       FROM usage_records r JOIN users u ON u.id = r.user_id
       WHERE r.self_reported = 0 AND r.created_at >= ? GROUP BY r.user_id
       ORDER BY SUM(r.input_tokens) + SUM(r.output_tokens) DESC, r.user_id LIMIT 20`,
    ).bind(since),
  ]);
  const byDay = new Map<string, any>(perDay.results.map((r: any) => [r.day, r]));
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = addDays(from, i);
    const r = byDay.get(day);
    out.push({ day, calls: r?.calls ?? 0, input_tokens: r?.input_tokens ?? 0, output_tokens: r?.output_tokens ?? 0, items: r?.items ?? 0 });
  }
  return json({
    days: out,
    top_users: top.results.map((r: any) => ({ user_id: r.user_id, email: r.email, calls: r.calls, input_tokens: r.input_tokens, output_tokens: r.output_tokens })),
  });
};

// ---------------------------------------------------------------- the routes

export const ADMIN_ROUTES: AdminRoute[] = [
  { method: "GET", path: "/admin/overview", why: "operator: counts, cron times and configuration flags", handler: getOverview },
  { method: "POST", path: "/admin/invites", why: "operator: invite one or several email addresses", handler: addInvites },
  { method: "GET", path: "/admin/invites", why: "operator: list invited addresses", handler: listInvites },
  { method: "DELETE", path: "/admin/invites", why: "operator: remove an invitation", handler: removeInvite },
  { method: "POST", path: "/admin/login-codes", why: "operator: mint a sign-in code to pass on", handler: mintCode },
  { method: "GET", path: "/admin/users", why: "operator: list accounts with their counts", handler: listUsers },
  { method: "GET", path: "/admin/users/{id}", why: "operator: one account, its devices, assistants and numbers", handler: getUserDetail },
  { method: "POST", path: "/admin/users/{id}/suspend", why: "operator: suspend an account", handler: suspendUser },
  { method: "POST", path: "/admin/users/{id}/restore", why: "operator: restore a suspended account", handler: restoreUser },
  { method: "POST", path: "/admin/users/{id}/sign-out", why: "operator: revoke every client device of an account", handler: signOutUser },
  { method: "DELETE", path: "/admin/users/{id}/devices/{device_id}", why: "operator: revoke one client device", handler: revokeUserDevice },
  { method: "DELETE", path: "/admin/users/{id}", why: "operator: delete an account and all its data", handler: deleteUser },
  { method: "GET", path: "/admin/usage", why: "operator: what the built-in assistants used", handler: getUsage },
  { method: "GET", path: "/admin/fetch", why: "operator: how saved links are read, and how it went", handler: getFetch },
  { method: "PUT", path: "/admin/fetch", why: "operator: turn the ways of reading links on and off, and order them", handler: putFetch },
  { method: "POST", path: "/admin/fetch/test", why: "operator: read one address with one way, now", handler: testFetch },
  { method: "GET", path: "/admin/feedback", why: "operator: what users wrote to the operator", handler: listFeedback },
  { method: "GET", path: "/admin/audit", why: "operator: the audit log", handler: listAudit },
  { method: "POST", path: "/admin/audit", why: "operator: an audit entry for something the portal did itself", handler: addAudit },
];
