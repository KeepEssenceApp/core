import { describe, expect, it } from "vitest";
import { CONTRACT } from "../src/generated/contract";
import { SERVER_INSTRUCTIONS } from "../src/mcp";
import { analysed, analysis, call, connectAssistant, coreTriage, db, idem, makeEnv, rpc, saveText, signIn, tool, withHelper } from "./helpers";

const names = async (env: any, token: string) => (await rpc(env, token, "tools/list")).json.result.tools.map((t: any) => t.name).sort();

describe("K20 assistant endpoint", () => {
  it("K20 endpoint: without a credential it answers 401 and points at the protected resource metadata", async () => {
    const env = makeEnv();
    const r = await rpc(env, null, "initialize", {});
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://core.test/.well-known/oauth-protected-resource"');
    expect((await rpc(env, "ka_wrong", "tools/list")).status).toBe(401);
  });

  it("K20 endpoint: initialize, ping, notifications and errors follow JSON-RPC over stateless HTTP", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    const init = await rpc(env, helper.access, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } }, 7);
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ jsonrpc: "2.0", id: 7, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "core" } } });
    expect(init.json.result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect((await rpc(env, helper.access, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(env, helper.access, "ping")).json).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const note = await rpc(env, helper.access, "notifications/initialized", undefined, null);
    expect(note.status).toBe(202);
    expect(note.text).toBe("");
    expect((await rpc(env, helper.access, "resources/list")).json.error.code).toBe(-32601);
    expect((await rpc(env, helper.access, "tools/call", { name: "no_such_tool", arguments: {} })).json.error.code).toBe(-32602);
    const bad = await call(env, "POST", "/mcp", { token: helper.access, raw: "{not json", headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe(-32700);
    // A batch: answers for the requests, nothing for the notification.
    const batch = await call(env, "POST", "/mcp", { token: helper.access, body: [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }] });
    expect(batch.json.map((x: any) => x.id)).toEqual([1, 2]);
  });

  it("K20 endpoint: the instructions tell the assistant how a deep dive goes, and their first 500 characters stand alone", async () => {
    const head = SERVER_INSTRUCTIONS.slice(0, 500);
    expect(head).toContain("A deep dive is a conversation");
    expect(head).toContain("Do not write the note yourself");
    expect(head).toContain("only after the user clearly says to save");
    expect(head).toContain("complete conclusions");
    expect(head).toContain("source");
    expect(SERVER_INSTRUCTIONS.indexOf("\n\n")).toBeLessThanOrEqual(500);
    expect(SERVER_INSTRUCTIONS.slice(0, SERVER_INSTRUCTIONS.indexOf("\n\n")).trim().endsWith(".")).toBe(true);
  });

  it("K20 endpoint: the tool list comes from the contract; read-only tools are marked", async () => {
    const env = makeEnv();
    const { helper } = await withHelper(env);
    const list = (await rpc(env, helper.access, "tools/list")).json.result.tools;
    expect(list.map((t: any) => t.name).sort()).toEqual(CONTRACT.tools.map((t) => t.name).sort());
    for (const t of list) {
      const source = CONTRACT.tools.find((c) => c.name === t.name)!;
      expect(t.inputSchema).toEqual(source.inputSchema);
      expect(t.description).toBe(source.description);
      expect(t.annotations).toEqual({ readOnlyHint: source.readOnly });
    }
    const readOnly = list.filter((t: any) => t.annotations.readOnlyHint).map((t: any) => t.name).sort();
    expect(readOnly).toEqual(["get_context", "get_digest_context", "get_rules", "list_deep_dive_candidates", "search_digests_and_notes"]);
  });

  it("K20 endpoint: a chat assistant gets exactly the four deep-dive abilities", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    expect(await names(env, chat.access)).toEqual(["get_context", "list_deep_dive_candidates", "register_deep_dive", "save_note"]);
    const analyst = await connectAssistant(env, ann, { name: "Analyst", kind: "scheduled", steps: ["analysis"] });
    expect(await names(env, analyst.access)).toEqual(["claim_work", "get_context", "get_rules", "release_claim", "renew_claim", "search_digests_and_notes", "submit_result"]);
  });

  it("K20 endpoint: calling outside the granted steps is an error with the meaning of 403, on the endpoint and on REST alike", async () => {
    const env = makeEnv();
    const { ann } = await withHelper(env);
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });
    const id = await saveText(env, ann.token, "A thought.");
    for (const [name, args] of [
      ["claim_work", { kind: "analysis" }],
      ["get_rules", { kind: "analysis" }],
      ["search_digests_and_notes", { q: "tea" }],
      ["get_digest_context", { day: "latest" }],
      ["get_context", { id, for: "analysis" }],
    ] as [string, Record<string, unknown>][]) {
      const r = await tool(env, chat.access, name, args);
      expect(`${name} ${r.isError} ${r.status} ${r.data.error.code}`).toBe(`${name} true 403 forbidden`);
    }
    expect((await call(env, "POST", "/v1/assistant/claims", { token: chat.access, body: { kind: "analysis" } })).status).toBe(403);
    expect((await call(env, "GET", "/v1/assistant/rules?kind=analysis", { token: chat.access })).status).toBe(403);
    expect((await call(env, "GET", "/v1/assistant/search?q=tea", { token: chat.access })).status).toBe(403);
    expect((await call(env, "GET", `/v1/assistant/items/${id}/context?for=analysis`, { token: chat.access })).status).toBe(403);
    // And the other way round: an assistant without the deep-dive step cannot save notes.
    const analyst = await connectAssistant(env, ann, { name: "Analyst", kind: "scheduled", steps: ["analysis"] });
    expect((await call(env, "POST", "/v1/assistant/notes", { token: analyst.access, body: { title: "t", body: "b" }, idem: idem() })).status).toBe(403);
    expect((await tool(env, analyst.access, "save_note", { title: "t", body: "b", idempotency_key: idem() })).status).toBe(403);
    expect(await db(env, "SELECT id FROM notes")).toEqual([]);
  });

  it("K20 endpoint: a deep dive through the tools — find the item, read it, register, and save the note when the user says so", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [id] = await analysed(env, ann, helper, ["Green tea likes cooler water. Steep it for two minutes."]);
    await saveText(env, ann.token, "Not analysed yet, so not a candidate.");
    await call(env, "PUT", `/v1/deep-read-queue/${id}`, { token: ann.token });
    const chat = await connectAssistant(env, ann, { name: "Talker", kind: "chat", scope: "deep_dive" });

    const found = await tool(env, chat.access, "list_deep_dive_candidates", { q: "green tea" });
    expect(found.isError).toBe(false);
    expect(found.data.candidates).toEqual([{ item_id: id, title: "Green tea likes cooler water.", summary: "A short note on brewing tea.", from: "queue", deep_read_ready: false }]);
    expect((await tool(env, chat.access, "list_deep_dive_candidates", { q: "coffee" })).data.candidates).toEqual([]);

    const ctx = await tool(env, chat.access, "get_context", { id, for: "deep_dive" });
    expect(ctx.data.item).toMatchObject({ id, title: "Green tea likes cooler water.", body: "Green tea likes cooler water. Steep it for two minutes." });
    expect(ctx.data.analysis.verdict).toBe("worth_deep_dive");
    // Same answer as the REST twin.
    expect((await call(env, "GET", `/v1/assistant/items/${id}/context?for=deep_dive`, { token: chat.access })).json).toEqual(ctx.data);
    expect((await call(env, "GET", "/v1/deep-read-queue", { token: ann.token })).json.entries[0].fetched_at).not.toBeNull();

    expect((await tool(env, chat.access, "register_deep_dive", { item_id: id })).data).toEqual({ item_id: id });
    expect((await tool(env, chat.access, "register_deep_dive", { item_id: "itm_nope" })).status).toBe(404);

    const key = idem();
    const args = { title: "What I learnt about green tea", body: "Use water at 80 degrees.\n\nSteep for two minutes.", item_id: id, sources: [{ title: "Tea handbook", url: "https://example.org/tea" }], idempotency_key: key };
    const saved = await tool(env, chat.access, "save_note", args);
    expect(saved.isError).toBe(false);
    expect(saved.data).toMatchObject({ title: "What I learnt about green tea", assistant: { id: chat.assistantId, name: "Talker" }, origin: { item_id: id }, sources: [{ title: "Tea handbook", url: "https://example.org/tea" }] });
    expect(saved.data.assistant.submitted_by_user).toBeUndefined();
    expect((await tool(env, chat.access, "save_note", args)).data.id).toBe(saved.data.id); // same key: the first answer
    expect((await tool(env, chat.access, "save_note", { title: "No key", body: "x" })).isError).toBe(true);
    // The user sees the note; the item left the queue; the day turns gold on the calendar.
    const notes = (await call(env, "GET", "/v1/notes", { token: ann.token })).json.notes;
    expect(notes.map((n: any) => n.id)).toEqual([saved.data.id]);
    expect((await call(env, "GET", "/v1/deep-read-queue", { token: ann.token })).json.entries).toEqual([]);
    const cal = (await call(env, "GET", "/v1/calendar", { token: ann.token })).json;
    expect(cal.days.find((d: any) => d.day === cal.today).mark).toBe("note");
    // A note is only ever stored when the tool is called: nothing else in the flow created one.
    expect(await db(env, "SELECT COUNT(*) AS n FROM notes")).toEqual([{ n: 1 }]);
  });

  it("K20 endpoint: a scheduled assistant can do its whole round through the tools, with the same checks as REST", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const id = await saveText(env, ann.token, "Analyse me through the tools.");
    await coreTriage(env);
    const rules = await tool(env, helper.access, "get_rules", { kind: "analysis" });
    expect(rules.data).toEqual((await call(env, "GET", "/v1/assistant/rules?kind=analysis", { token: helper.access })).json);
    expect(rules.data).toMatchObject({ rules: "", expiry_options: [7, 30, 90, 365], lang: "en", timezone: "Asia/Shanghai", default_analysis_assistant: "Helper" });
    const claimed = await tool(env, helper.access, "claim_work", { kind: "analysis", limit: 5 });
    expect(claimed.data.work).toEqual([{ ref: id, title: "Analyse me through the tools." }]);
    const bad = await tool(env, helper.access, "submit_result", { id: claimed.data.claim_id, idempotency_key: idem(), results: [analysis(id, { summary: "x".repeat(61) })] });
    expect(bad).toMatchObject({ isError: true, status: 400 });
    expect(bad.data.error.code).toBe("invalid_result");
    expect((await tool(env, helper.access, "renew_claim", { id: claimed.data.claim_id })).data.claim_id).toBe(claimed.data.claim_id);
    const ok = await tool(env, helper.access, "submit_result", { id: claimed.data.claim_id, idempotency_key: idem(), results: [analysis(id)], usage: { model: "m", input_tokens: 10, output_tokens: 5, calls: 1 } });
    expect(ok.data.outcomes).toEqual([{ ref: id, accepted: true }]);
    expect((await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json.stage).toBe("analysed");
    expect((await tool(env, helper.access, "release_claim", { id: claimed.data.claim_id })).isError).toBe(false);
    expect((await tool(env, helper.access, "claim_work", { kind: "analysis", limit: 50 })).data.error.code).toBe("bad_request");
    // Looking things up in digests and notes is context for work.
    await call(env, "POST", "/v1/notes", { token: ann.token, body: { title: "Oolong", body: "Ninety degrees for oolong." }, idem: idem() });
    const hits = await tool(env, helper.access, "search_digests_and_notes", { q: "oolong" });
    expect(hits.data.matches).toEqual([{ kind: "note", ref: expect.any(String), title: "Oolong", excerpt: "Ninety degrees for oolong." }]);
  });
});
