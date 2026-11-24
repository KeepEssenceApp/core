// The authorization server for assistants: metadata (RFC 8414, RFC 9728), dynamic registration
// (RFC 7591), client metadata documents, authorization code with PKCE (S256), opaque access
// credentials (one hour, stored hashed), refresh rotation with reuse detection, revocation.
// There is no fixed-credential path.
import { CONTRACT } from "../generated/contract";
import { HOUR, MINUTE, now } from "../clock";
import { num, outbound, type Env } from "../env";
import { err } from "../errors";
import { ok, type AssistantRow, type Cx, type Handler, type Result, type Step } from "../types";
import { b64url, newId, parseJson, randomToken, sha256Hex } from "../util";
import { dropAssistantCredentials } from "../services/accounts";
import { isPublicUrl } from "../services/fetchpage";
import { ipKey, rateLimit } from "../services/guard";

const STEPS = CONTRACT.steps as Step[];
const REQUEST_MINUTES = 10;
const CODE_MINUTES = 5;
const ACCESS_SECONDS = 3600;

export const getAuthorizationServerMetadata: Handler = async (cx) =>
  ok({
    issuer: cx.origin,
    authorization_endpoint: `${cx.origin}/oauth/authorize`,
    token_endpoint: `${cx.origin}/oauth/token`,
    registration_endpoint: `${cx.origin}/oauth/register`,
    revocation_endpoint: `${cx.origin}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: STEPS,
    client_id_metadata_document_supported: true,
  });

export const getProtectedResourceMetadata: Handler = async (cx) =>
  ok({
    resource: `${cx.origin}/mcp`,
    authorization_servers: [cx.origin],
    scopes_supported: STEPS,
    bearer_methods_supported: ["header"],
  });

/** https anywhere, http only on the loopback interface, or an app's own scheme. */
function redirectAllowed(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"].includes(url.protocol) && /^[a-z][a-z0-9+.-]*:$/.test(url.protocol);
}

async function limitPublic(cx: Cx, name: string): Promise<void> {
  await rateLimit(cx.env, `${name}:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30), 10 * MINUTE);
}

export const registerClient: Handler = async (cx) => {
  await limitPublic(cx, "oauth-register");
  const uris: string[] = cx.body.redirect_uris;
  if (!uris.every(redirectAllowed)) {
    throw err("bad_request", "redirect_uris 里有不允许的地址。", "redirect_uris contains an address that is not allowed.");
  }
  const clientId = "client_" + randomToken(18);
  await cx.env.DB.prepare("INSERT INTO oauth_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(clientId, cx.body.client_name ?? null, cx.body.client_uri ?? null, JSON.stringify(uris), now())
    .run();
  return ok(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: cx.body.client_name,
      client_uri: cx.body.client_uri,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
  );
};

interface Client {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  redirect_uris: string[];
}

/** A registered id, or an https URL of a client metadata document (fetched, checked, cached for an hour). */
async function resolveClient(env: Env, clientId: string): Promise<Client | null> {
  const row = await env.DB.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").bind(clientId).first<any>();
  const isDocument = /^https:\/\/[^/]+\/.+/.test(clientId);
  if (row && (!isDocument || now() - row.created_at < HOUR)) {
    return { client_id: row.client_id, client_name: row.client_name, client_uri: row.client_uri, redirect_uris: parseJson<string[]>(row.redirect_uris, []) };
  }
  if (!isDocument || !isPublicUrl(clientId)) return null;
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 5000);
    const response = await outbound(env, clientId, { redirect: "error", signal: abort.signal, headers: { accept: "application/json" } });
    const text = response.ok ? (await response.text()).slice(0, 65536) : "";
    clearTimeout(timer);
    const doc = JSON.parse(text);
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris) || doc.redirect_uris.length === 0) return null;
    const uris = doc.redirect_uris.filter((u: unknown): u is string => typeof u === "string" && redirectAllowed(u)).slice(0, 10);
    const client: Client = {
      client_id: clientId,
      client_name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 80) : null,
      client_uri: typeof doc.client_uri === "string" ? doc.client_uri.slice(0, 300) : null,
      redirect_uris: uris,
    };
    await env.DB.prepare("INSERT OR REPLACE INTO oauth_clients (client_id, client_name, client_uri, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(client.client_id, client.client_name, client.client_uri, JSON.stringify(uris), now())
      .run();
    return client;
  } catch {
    return null;
  }
}

/** Start of the flow: validate, remember the request for 10 minutes, send the browser to the allow page. */
export const authorize: Handler = async (cx) => {
  await limitPublic(cx, "oauth-authorize");
  const q = cx.query;
  const client = await resolveClient(cx.env, q.client_id);
  if (!client) throw err("bad_request", "不认识这个 client_id。", "Unknown client_id.");
  if (!client.redirect_uris.includes(q.redirect_uri)) {
    throw err("bad_request", "redirect_uri 和这个客户端登记的不一致。", "redirect_uri does not match the ones this client registered.");
  }
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(q.code_challenge)) throw err("bad_request", "code_challenge 格式不对。", "code_challenge has the wrong format.");
  if (q.resource && !String(q.resource).startsWith(cx.origin)) throw err("bad_request", "resource 不是这个核心。", "resource is not this core.");
  const asked = String(q.scope ?? "")
    .split(/\s+/)
    .filter((s): s is Step => (STEPS as string[]).includes(s));
  // Triage belongs to the built-in dispatch assistant; a connecting assistant cannot ask for it.
  const steps = (asked.length > 0 ? asked : STEPS).filter((s) => s !== "triage");
  if (steps.length === 0) throw err("bad_request", "scope 里没有可以授权的步骤。", "scope names no step that can be granted.");
  const id = "req_" + randomToken(24);
  await cx.env.DB.prepare(
    `INSERT INTO oauth_requests (id, client_id, client_name, client_uri, redirect_uri, state, code_challenge, steps, resource, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(id, client.client_id, client.client_name ?? new URL(q.redirect_uri).hostname, client.client_uri, q.redirect_uri, q.state ?? null, q.code_challenge, JSON.stringify([...new Set(steps)]), q.resource ?? null, now() + REQUEST_MINUTES * MINUTE, now())
    .run();
  const app = cx.env.APP_ORIGIN || cx.origin;
  return new Response(null, { status: 302, headers: { location: `${app}/authorize?request=${id}`, "cache-control": "no-store" } });
};

interface RequestRow {
  id: string;
  client_id: string;
  client_name: string;
  client_uri: string | null;
  redirect_uri: string;
  state: string | null;
  code_challenge: string;
  steps: string;
  status: string;
  expires_at: number;
}

async function pendingRequest(cx: Cx): Promise<RequestRow> {
  const row = await cx.env.DB.prepare("SELECT * FROM oauth_requests WHERE id = ?").bind(cx.path.request_id).first<RequestRow>();
  if (!row || row.status !== "pending" || row.expires_at <= now()) throw err("gone");
  return row;
}

function hostOf(uri: string): string {
  const url = new URL(uri);
  return url.host || url.protocol.replace(/:$/, "");
}

/** What the allow page shows: who asks, which steps, and where the content will be sent. */
export const getAuthorizationRequest: Handler = async (cx) => {
  const row = await pendingRequest(cx);
  return ok({ client_name: row.client_name, client_uri: row.client_uri, redirect_host: hostOf(row.redirect_uri), steps_requested: parseJson<Step[]>(row.steps, []) });
};

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  return url.toString();
}

/** The user allows or refuses. Allowing creates the assistant (name, kind, steps) and a one-time code. */
export const decideAuthorizationRequest: Handler = async (cx) => {
  const row = await pendingRequest(cx);
  const user = cx.user!;
  const requested = parseJson<Step[]>(row.steps, []);
  if (!cx.body.allow) {
    await cx.env.DB.prepare("UPDATE oauth_requests SET status = 'denied' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    return ok({ redirect_to: redirectWith(row.redirect_uri, { error: "access_denied", state: row.state }) });
  }
  const name = (cx.body.name ?? "").trim();
  if (!name) throw err("bad_request", "允许时要给助手起个名字。", "A name for the assistant is required when allowing.");
  let steps: Step[] = cx.body.steps ? [...new Set<Step>(cx.body.steps)] : requested;
  const kind: "scheduled" | "chat" = cx.body.kind ?? (steps.every((s) => s === "deep_dive") ? "chat" : "scheduled");
  if (cx.body.steps === undefined && kind === "chat") steps = steps.filter((s) => s === "deep_dive");
  if (steps.some((s) => !requested.includes(s))) {
    throw err("bad_request", "步骤可以勾掉，不能比对方请求的多。", "Steps may be removed, never added beyond what was requested.");
  }
  if (kind === "chat" && steps.some((s) => s !== "deep_dive")) throw err("bad_request", "对话型助手只能深挖。", "A chat assistant can only deep dive.");
  if (steps.length === 0) throw err("bad_request", "至少要允许一步。", "At least one step must be allowed.");
  const taken = await cx.env.DB.prepare("UPDATE oauth_requests SET status = 'allowed' WHERE id = ? AND status = 'pending'").bind(row.id).run();
  if (taken.meta.changes === 0) throw err("gone");
  const assistantId = newId("ast");
  const code = "kc_" + randomToken(32);
  try {
    await cx.env.DB.batch([
      cx.env.DB.prepare(
        "INSERT INTO assistants (id, user_id, name, kind, steps, client_id, runs_at, connected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(assistantId, user.id, name, kind, JSON.stringify(steps), row.client_id, hostOf(row.redirect_uri), now()),
      cx.env.DB.prepare(
        "INSERT INTO oauth_codes (code_hash, user_id, assistant_id, client_id, redirect_uri, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(await sha256Hex(code), user.id, assistantId, row.client_id, row.redirect_uri, row.code_challenge, now() + CODE_MINUTES * MINUTE),
    ]);
  } catch (e) {
    await cx.env.DB.prepare("UPDATE oauth_requests SET status = 'pending' WHERE id = ?").bind(row.id).run();
    if (String(e).includes("UNIQUE")) throw err("conflict", "已经有一只助手叫这个名字。", "Another assistant already has this name.");
    throw e;
  }
  return ok({ redirect_to: redirectWith(row.redirect_uri, { code, state: row.state, iss: cx.origin }) });
};

// ---------------------------------------------------------------- token endpoint

function oauthError(error: string, description: string): Result {
  return { status: 400, body: { error, error_description: description }, headers: { "cache-control": "no-store" } };
}

async function issue(env: Env, userId: string, assistant: AssistantRow, clientId: string): Promise<Result> {
  const access = "ka_" + randomToken(32);
  const refresh = "kr_" + randomToken(32);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO oauth_access (credential_hash, user_id, assistant_id, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256Hex(access), userId, assistant.id, now() + ACCESS_SECONDS * 1000),
    env.DB.prepare("INSERT INTO oauth_refresh (credential_hash, user_id, assistant_id, client_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(await sha256Hex(refresh), userId, assistant.id, clientId, now()),
  ]);
  return {
    status: 200,
    body: { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: parseJson<string[]>(assistant.steps, []).join(" ") },
    headers: { "cache-control": "no-store" },
  };
}

async function liveAssistant(env: Env, userId: string, assistantId: string): Promise<AssistantRow | null> {
  return env.DB.prepare("SELECT * FROM assistants WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(assistantId, userId).first<AssistantRow>();
}

export const token: Handler = async (cx) => {
  await rateLimit(cx.env, `oauth-token:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30) * 10, 10 * MINUTE);
  const b = cx.body;
  if (b.grant_type === "authorization_code") {
    if (!b.code || !b.code_verifier) return oauthError("invalid_request", "code and code_verifier are required");
    const hash = await sha256Hex(b.code);
    const row = await cx.env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").bind(hash).first<any>();
    if (!row) return oauthError("invalid_grant", "unknown code");
    if (row.used_at) {
      // A code presented twice: whatever was issued from it is withdrawn.
      await dropAssistantCredentials(cx.env, row.user_id, row.assistant_id);
      return oauthError("invalid_grant", "code already used");
    }
    if (row.expires_at <= now()) return oauthError("invalid_grant", "code expired");
    if (b.client_id !== undefined && b.client_id !== row.client_id) return oauthError("invalid_grant", "client_id does not match");
    if (b.redirect_uri !== undefined && b.redirect_uri !== row.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match");
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(b.code_verifier)));
    if (challenge !== row.code_challenge) return oauthError("invalid_grant", "code_verifier does not match");
    const used = await cx.env.DB.prepare("UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL").bind(now(), hash).run();
    if (used.meta.changes === 0) return oauthError("invalid_grant", "code already used");
    const assistant = await liveAssistant(cx.env, row.user_id, row.assistant_id);
    if (!assistant) return oauthError("invalid_grant", "the assistant was disconnected");
    return issue(cx.env, row.user_id, assistant, row.client_id);
  }
  // refresh_token: every use rotates. Presenting an old one again means it leaked: everything goes.
  if (!b.refresh_token) return oauthError("invalid_request", "refresh_token is required");
  const hash = await sha256Hex(b.refresh_token);
  const row = await cx.env.DB.prepare("SELECT * FROM oauth_refresh WHERE credential_hash = ?").bind(hash).first<any>();
  if (!row) return oauthError("invalid_grant", "unknown refresh credential");
  if (b.client_id !== undefined && b.client_id !== row.client_id) return oauthError("invalid_grant", "client_id does not match");
  const rotated = row.rotated_at ? { meta: { changes: 0 } } : await cx.env.DB.prepare("UPDATE oauth_refresh SET rotated_at = ? WHERE credential_hash = ? AND rotated_at IS NULL").bind(now(), hash).run();
  if (rotated.meta.changes === 0) {
    await dropAssistantCredentials(cx.env, row.user_id, row.assistant_id);
    return oauthError("invalid_grant", "refresh credential was already used; all credentials of this assistant were withdrawn");
  }
  const assistant = await liveAssistant(cx.env, row.user_id, row.assistant_id);
  if (!assistant) return oauthError("invalid_grant", "the assistant was disconnected");
  // The access credentials issued with the old refresh credential stop with it.
  await cx.env.DB.prepare("DELETE FROM oauth_access WHERE assistant_id = ? AND user_id = ?").bind(assistant.id, row.user_id).run();
  return issue(cx.env, row.user_id, assistant, row.client_id);
};

/** RFC 7009: always 200. The assistant loses its credentials and its claims go back. */
export const revoke: Handler = async (cx) => {
  await rateLimit(cx.env, `oauth-revoke:${await ipKey(cx.env, cx.request)}`, num(cx.env.PUBLIC_RATE_PER_10_MIN, 30) * 10, 10 * MINUTE);
  const hash = await sha256Hex(String(cx.body.token ?? ""));
  const row =
    (await cx.env.DB.prepare("SELECT user_id, assistant_id FROM oauth_refresh WHERE credential_hash = ?").bind(hash).first<any>()) ??
    (await cx.env.DB.prepare("SELECT user_id, assistant_id FROM oauth_access WHERE credential_hash = ?").bind(hash).first<any>());
  if (row) await dropAssistantCredentials(cx.env, row.user_id, row.assistant_id);
  return { status: 200, body: {} };
};
