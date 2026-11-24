import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { CONTRACT } from "../src/generated/contract";
import { b64url } from "../src/util";
import { analysis, call, claim, connectAssistant, connectDevice, coreTriage, db, makeEnv, refresh, saveText, signIn, submit, withHelper } from "./helpers";

const REDIRECT = "https://assistant.example/callback";

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

async function start(env: any, clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", ...extra });
  return call(env, "GET", `/oauth/authorize?${q}`);
}

async function register(env: any) {
  return (await call(env, "POST", "/oauth/register", { body: { client_name: "Reading helper", client_uri: "https://assistant.example", redirect_uris: [REDIRECT] } })).json.client_id as string;
}

const requestOf = (r: any) => new URL(r.headers.get("location")).searchParams.get("request")!;

describe("K19 connecting an assistant", () => {
  it("K19 oauth: metadata for the authorization server (RFC 8414) and the protected resource (RFC 9728)", async () => {
    const env = makeEnv();
    const as = (await call(env, "GET", "/.well-known/oauth-authorization-server")).json;
    expect(as).toMatchObject({
      issuer: "https://core.test",
      authorization_endpoint: "https://core.test/oauth/authorize",
      token_endpoint: "https://core.test/oauth/token",
      registration_endpoint: "https://core.test/oauth/register",
      revocation_endpoint: "https://core.test/oauth/revoke",
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    const pr = (await call(env, "GET", "/.well-known/oauth-protected-resource")).json;
    expect(pr).toMatchObject({ resource: "https://core.test/mcp", authorization_servers: ["https://core.test"] });
  });

  it("K19 oauth: dynamic registration, authorization code with PKCE, and the allow page creates the assistant", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reg = await call(env, "POST", "/oauth/register", { body: { client_name: "Reading helper", client_uri: "https://assistant.example", redirect_uris: [REDIRECT] } });
    expect(reg.status).toBe(201);
    expect(reg.json).toMatchObject({ token_endpoint_auth_method: "none", redirect_uris: [REDIRECT] });
    expect(reg.json.client_secret).toBeUndefined();
    const { verifier, challenge } = await pkce();
    const auth = await start(env, reg.json.client_id, challenge, { scope: "analysis digest deep_dive", resource: "https://core.test/mcp" });
    expect(auth.status).toBe(302);
    expect(auth.headers.get("location")).toMatch(/^https:\/\/app\.test\/authorize\?request=req_[\w-]+$/);
    const requestId = requestOf(auth);
    // The allow page: who asks, for which steps, and where the content will be sent.
    const info = await call(env, "GET", `/v1/oauth/requests/${requestId}`, { token: ann.token });
    expect(info.json).toEqual({ client_name: "Reading helper", client_uri: "https://assistant.example", redirect_host: "assistant.example", steps_requested: ["analysis", "digest", "deep_dive"] });
    const reader = await connectDevice(env, ann, "read");
    expect((await call(env, "POST", `/v1/oauth/requests/${requestId}/decision`, { token: reader.token, body: { allow: true, name: "x" } })).status).toBe(403);
    // The user names it and unticks a step.
    const decision = await call(env, "POST", `/v1/oauth/requests/${requestId}/decision`, { token: ann.token, body: { allow: true, name: "Night reader", kind: "scheduled", steps: ["analysis", "deep_dive"] } });
    expect(decision.status).toBe(200);
    const back = new URL(decision.json.redirect_to);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("xyz");
    const code = back.searchParams.get("code")!;
    const tok = await call(env, "POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: reg.json.client_id, redirect_uri: REDIRECT } });
    expect(tok.status).toBe(200);
    expect(tok.json).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "analysis deep_dive" });
    expect((await call(env, "GET", "/v1/assistant/work", { token: tok.json.access_token })).status).toBe(200);
    const listed = (await call(env, "GET", "/v1/assistants", { token: ann.token })).json;
    expect(listed.connect_url).toBe("https://core.test/mcp");
    const mine = listed.assistants.find((a: any) => a.name === "Night reader");
    expect(mine).toMatchObject({ kind: "scheduled", steps: ["analysis", "deep_dive"], built_in: false, runs_at: "assistant.example" });
    // It is also a device: listed with the clients, with its steps instead of a tier.
    const dev = (await call(env, "GET", "/v1/devices", { token: ann.token })).json.devices.find((d: any) => d.id === mine.id);
    expect(dev).toMatchObject({ category: "assistant", steps: ["analysis", "deep_dive"] });
    // The request cannot be decided twice.
    expect((await call(env, "POST", `/v1/oauth/requests/${requestId}/decision`, { token: ann.token, body: { allow: true, name: "Again" } })).status).toBe(410);
    expect((await call(env, "GET", `/v1/oauth/requests/${requestId}`, { token: ann.token })).status).toBe(410);
  });

  it("K19 oauth: the authorize request is checked — unknown client, other redirect, no PKCE or a method other than S256 are refused", async () => {
    const env = makeEnv();
    const clientId = await register(env);
    const { challenge } = await pkce();
    expect((await start(env, "client_unknown", challenge)).status).toBe(400);
    expect((await start(env, clientId, challenge, { redirect_uri: "https://evil.example/cb" })).status).toBe(400);
    expect((await start(env, clientId, challenge, { code_challenge_method: "plain" })).status).toBe(400);
    expect((await start(env, clientId, challenge, { response_type: "token" })).status).toBe(400);
    expect((await start(env, clientId, "short")).status).toBe(400);
    const q = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT });
    expect((await call(env, "GET", `/oauth/authorize?${q}`)).status).toBe(400);
    expect((await call(env, "POST", "/oauth/register", { body: { redirect_uris: ["javascript:alert(1)"] } })).status).toBe(400);
    expect((await call(env, "POST", "/oauth/register", { body: { redirect_uris: ["http://evil.example/cb"] } })).status).toBe(400);
    expect((await call(env, "POST", "/oauth/register", { body: { redirect_uris: ["http://127.0.0.1:7777/cb", "myapp://callback"] } })).status).toBe(201);
    expect(await db(env, "SELECT id FROM oauth_requests")).toEqual([]);
  });

  it("K19 oauth: a client may identify itself with the https address of a client metadata document", async () => {
    const doc = "https://assistant.example/oauth/client.json";
    const seen: string[] = [];
    const env = makeEnv({
      OUTBOUND: async (url) => {
        seen.push(url);
        return Response.json({ client_id: doc, client_name: "Document client", redirect_uris: [REDIRECT] });
      },
    });
    const ann = await signIn(env);
    const { verifier, challenge } = await pkce();
    const auth = await start(env, doc, challenge, { scope: "deep_dive" });
    expect(auth.status).toBe(302);
    expect(seen).toEqual([doc]);
    expect((await call(env, "GET", `/v1/oauth/requests/${requestOf(auth)}`, { token: ann.token })).json.client_name).toBe("Document client");
    const decision = await call(env, "POST", `/v1/oauth/requests/${requestOf(auth)}/decision`, { token: ann.token, body: { allow: true, name: "Talker", kind: "chat" } });
    const code = new URL(decision.json.redirect_to).searchParams.get("code")!;
    expect((await call(env, "POST", "/oauth/token", { form: { grant_type: "authorization_code", code, code_verifier: verifier, client_id: doc } })).status).toBe(200);
    // A document that names another client, or lives at a non-public address, is refused.
    const liar = makeEnv({ OUTBOUND: async () => Response.json({ client_id: "https://other.example/c.json", redirect_uris: [REDIRECT] }) });
    expect((await start(liar, "https://liar.example/c.json", challenge)).status).toBe(400);
    expect((await start(env, "https://127.0.0.1/c.json", challenge)).status).toBe(400);
  });

  it("K19 oauth: a request lives 10 minutes; refusing sends the browser back with an error and creates nothing", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const clientId = await register(env);
    const { challenge } = await pkce();
    const a = await start(env, clientId, challenge);
    const denied = await call(env, "POST", `/v1/oauth/requests/${requestOf(a)}/decision`, { token: ann.token, body: { allow: false } });
    const back = new URL(denied.json.redirect_to);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("code")).toBeNull();
    const b = await start(env, clientId, challenge);
    advance(10 * MINUTE + 1000);
    expect((await call(env, "GET", `/v1/oauth/requests/${requestOf(b)}`, { token: ann.token })).status).toBe(410);
    expect((await call(env, "POST", `/v1/oauth/requests/${requestOf(b)}/decision`, { token: ann.token, body: { allow: true, name: "Late" } })).status).toBe(410);
    expect((await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants).toHaveLength(1);
  });

  it("K19 oauth: a chat assistant can only deep dive; steps may be removed, never added; names are unique", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const clientId = await register(env);
    const { challenge } = await pkce();
    const decide = async (body: unknown, scope = "analysis deep_dive") => {
      const auth = await start(env, clientId, challenge, { scope });
      return call(env, "POST", `/v1/oauth/requests/${requestOf(auth)}/decision`, { token: ann.token, body });
    };
    expect((await decide({ allow: true, name: "Talker", kind: "chat", steps: ["analysis", "deep_dive"] })).status).toBe(400);
    expect((await decide({ allow: true, name: "Greedy", kind: "scheduled", steps: ["analysis", "digest"] })).status).toBe(400);
    expect((await decide({ allow: true })).status).toBe(400);
    expect((await decide({ allow: true, name: "Empty", steps: [] })).status).toBe(400);
    expect((await decide({ allow: true, name: "Talker", kind: "chat" })).status).toBe(200);
    const talker = (await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants.find((a: any) => a.name === "Talker");
    expect(talker).toMatchObject({ kind: "chat", steps: ["deep_dive"] });
    const dup = await decide({ allow: true, name: "Talker", kind: "scheduled" });
    expect(dup.status).toBe(409);
    // A chat assistant cannot be made the one for analysis or digest, nor given other steps later.
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { roles: { analysis: talker.id } } })).status).toBe(400);
    expect((await call(env, "PATCH", `/v1/assistants/${talker.id}`, { token: ann.token, body: { steps: ["analysis"] } })).status).toBe(409);
    const renamed = await call(env, "PATCH", `/v1/assistants/${talker.id}`, { token: ann.token, body: { name: "Evening talk" } });
    expect(renamed.json.name).toBe("Evening talk");
  });

  it("K19 oauth: the code works once and only with the right verifier", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const clientId = await register(env);
    const { verifier, challenge } = await pkce();
    const auth = await start(env, clientId, challenge);
    const decision = await call(env, "POST", `/v1/oauth/requests/${requestOf(auth)}/decision`, { token: ann.token, body: { allow: true, name: "Helper" } });
    const code = new URL(decision.json.redirect_to).searchParams.get("code")!;
    const form = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT };
    const wrong = await call(env, "POST", "/oauth/token", { form: { ...form, code_verifier: "w".repeat(43) } });
    expect(wrong.status).toBe(400);
    expect(wrong.json.error).toBe("invalid_grant");
    expect((await call(env, "POST", "/oauth/token", { form: { ...form, code_verifier: verifier, redirect_uri: "https://evil.example/cb" } })).json.error).toBe("invalid_grant");
    expect((await call(env, "POST", "/oauth/token", { form: { ...form, code_verifier: verifier, client_id: "client_other" } })).json.error).toBe("invalid_grant");
    const ok = await call(env, "POST", "/oauth/token", { form: { ...form, code_verifier: verifier } });
    expect(ok.status).toBe(200);
    // Used a second time: refused, and what was issued from it is withdrawn.
    expect((await call(env, "POST", "/oauth/token", { form: { ...form, code_verifier: verifier } })).json.error).toBe("invalid_grant");
    expect((await call(env, "GET", "/v1/assistant/work", { token: ok.json.access_token })).status).toBe(401);
    expect((await call(env, "POST", "/oauth/token", { form: { grant_type: "password", username: "a", password: "b" } })).status).toBe(400);
  });

  it("K19 oauth: access lasts one hour; the refresh credential rotates on every use, and using an old one withdraws everything", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    const first = { access: helper.access, refresh: helper.refresh };
    advance(59 * MINUTE);
    expect((await call(env, "GET", "/v1/assistant/work", { token: first.access })).status).toBe(200);
    advance(2 * MINUTE);
    expect((await call(env, "GET", "/v1/assistant/work", { token: first.access })).status).toBe(401);
    // The assistant renews by itself, as often as it likes, with no user involved.
    await refresh(env, helper);
    expect(helper.refresh).not.toBe(first.refresh);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(200);
    advance(100 * 24 * 60 * MINUTE); // refresh credentials do not expire
    const second = { access: helper.access, refresh: helper.refresh };
    await refresh(env, helper);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(200);
    expect((await call(env, "GET", "/v1/assistant/work", { token: second.access })).status).toBe(401);
    // Replaying a refresh credential that was already used: refused, and the current ones die too.
    const replay = await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: second.refresh } });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(401);
    expect((await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh } })).json.error).toBe("invalid_grant");
    // Credentials are stored as hashes only.
    const dump = JSON.stringify([await db(env, "SELECT * FROM oauth_access"), await db(env, "SELECT * FROM oauth_refresh"), await db(env, "SELECT * FROM oauth_codes")]);
    for (const secret of [first.access, first.refresh, second.access, second.refresh, helper.access, helper.refresh]) expect(dump).not.toContain(secret);
  });

  it("K19 oauth: disconnecting an assistant takes effect at once and puts back what it had claimed", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const a = await saveText(env, ann.token, "Claimed by the helper.");
    const b = await saveText(env, ann.token, "Queued for the helper.");
    await coreTriage(env);
    await call(env, "PUT", `/v1/deep-read-queue/${b}`, { token: ann.token });
    const c1 = await claim(env, helper.access, "analysis");
    await claim(env, helper.access, "deep_read");
    expect((await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).length).toBe(2);
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.assistants.find((x: any) => x.name === "Helper").state).toBe("working");

    expect((await call(env, "DELETE", `/v1/assistants/${helper.assistantId}`, { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(401);
    expect((await submit(env, helper.access, c1.claim_id, [analysis(a)])).status).toBe(401);
    expect((await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh } })).json.error).toBe("invalid_grant");
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toEqual([]);
    expect(await db(env, "SELECT item_id FROM deep_read_queue WHERE claim_id IS NOT NULL")).toEqual([]);
    expect(await db(env, "SELECT id FROM claims WHERE status = 'active'")).toEqual([]);
    // It is gone from the lists; analysis and digest fall back to the built-in assistant, the rest to nobody.
    const assistants = (await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants;
    expect(assistants.map((x: any) => x.name)).toEqual(["Built-in assistant"]);
    const roles = (await call(env, "GET", "/v1/settings", { token: ann.token })).json.roles;
    expect(roles).toEqual({ analysis: assistants[0].id, digest: assistants[0].id, deep_read: null, deep_dive: null });
    expect((await call(env, "GET", `/v1/items/${a}`, { token: ann.token })).json.dispatch_to.id).toBe(assistants[0].id);
    expect((await call(env, "DELETE", `/v1/assistants/${assistants[0].id}`, { token: ann.token })).status).toBe(409);
  });

  it("K19 oauth: revoking through the device list or the revocation endpoint works the same way", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await saveText(env, ann.token, "Claimed.");
    await coreTriage(env);
    await claim(env, helper.access, "analysis");
    expect((await call(env, "POST", "/oauth/revoke", { form: { token: helper.refresh } })).status).toBe(200);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).status).toBe(401);
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toEqual([]);
    expect((await call(env, "POST", "/oauth/revoke", { form: { token: "unknown" } })).status).toBe(200);
    const other = await connectAssistant(env, ann, { name: "Other" });
    expect((await call(env, "DELETE", `/v1/devices/${other.assistantId}`, { token: ann.token })).status).toBe(204);
    expect((await call(env, "GET", "/v1/assistant/work", { token: other.access })).status).toBe(401);
  });

  it("K19 oauth: there is no fixed-credential path", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    // The contract has no operation that creates an assistant or hands out a credential outside the flow.
    expect(CONTRACT.operations.some((o) => o.method === "POST" && o.path === "/v1/assistants")).toBe(false);
    expect((await call(env, "POST", "/v1/assistants", { token: ann.token, body: { name: "Keyed" } })).status).toBe(405);
    // A device credential, the admin secret or an invented value do not work as an assistant credential.
    for (const token of [ann.token, "test-admin-secret", "sk-fixed-key", ""]) {
      expect((await call(env, "GET", "/v1/assistant/work", { token })).status).toBe(401);
      expect((await call(env, "POST", "/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "ping" } })).status).toBe(401);
    }
    // Every access credential in the database has an expiry of one hour.
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    const rows = await db(env, "SELECT expires_at FROM oauth_access");
    expect(rows).toHaveLength(1);
    expect(rows[0].expires_at - (await import("../src/clock")).now()).toBe(60 * MINUTE);
    expect(helper.access.length).toBeGreaterThan(40);
  });
});
