import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { call, connectAssistant, db, LLM, makeEnv, modelStub, saveText, signIn, withHelper } from "./helpers";

const item = async (env: any, token: string, id: string) => (await call(env, "GET", `/v1/items/${id}`, { token })).json;

describe("K8 triage", () => {
  it("K8 triage: the dispatch assistant reads only title, site and opening, and hands back assistant and expiry", async () => {
    const calls: any[] = [];
    const base = makeEnv();
    const { ann, helper } = await withHelper(base);
    await call(base, "PATCH", "/v1/settings", { token: ann.token, body: { rules: "Anything about tea goes to Helper for 7 days." } });
    const long = "Tea opening sentence. " + "filler ".repeat(120) + "DEEP-IN-THE-BODY-MARKER";
    const id = await saveText(base, ann.token, long, "Tea notes");
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub((req) => [{ item_id: JSON.parse(req.messages[0].content).items[0].item_id, assistant: "Helper", expiry_days: 7 }], calls) });
    await runMinute(env);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://model.test/v1/messages");
    expect(calls[0].headers).toMatchObject({ "x-api-key": "test-model-key", authorization: "Bearer test-model-key", "anthropic-version": "2023-06-01" });
    expect(calls[0].request.model).toBe("claude-haiku-5-5");
    const sent = JSON.stringify(calls[0].request);
    expect(sent).toContain("Tea notes");
    expect(sent).toContain("Tea opening sentence.");
    expect(sent).toContain("Anything about tea goes to Helper");
    expect(sent).not.toContain("DEEP-IN-THE-BODY-MARKER");

    const got = await item(env, ann.token, id);
    expect(got).toMatchObject({ stage: "triaged", days_left: 7, expiry_days: 7, dispatch_to: { id: helper.assistantId, name: "Helper" } });
    expect(got.tags).toEqual(expect.arrayContaining(["assistant:Helper", "expiry:7"]));
    // Triage never notifies, and the core records its own usage as not self-reported.
    expect(await db(env, "SELECT * FROM notify_batches")).toHaveLength(0);
    const usage = await db(env, "SELECT kind, self_reported, input_tokens, items FROM usage_records");
    expect(usage).toEqual([{ kind: "triage", self_reported: 0, input_tokens: 120, items: 1 }]);
  });

  it("K8 triage: what the model leaves out or makes up is replaced by the defaults", async () => {
    const base = makeEnv();
    const ann = await signIn(base);
    const a = await saveText(base, ann.token, "First.");
    const b = await saveText(base, ann.token, "Second.");
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub(() => "Here you go:\n```json\n" + JSON.stringify([{ item_id: a, assistant: "Nobody I know", expiry_days: 12 }]) + "\n```") });
    await runMinute(env);
    const worker = (await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants[0];
    for (const id of [a, b]) {
      expect(await item(env, ann.token, id)).toMatchObject({ stage: "triaged", expiry_days: 30, dispatch_to: { id: worker.id } });
    }
  });

  it("K8 triage: with no dispatch assistant running, the core gives the defaults after 10 minutes, not before", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Waiting for triage.");
    advance(9 * MINUTE);
    await runMinute(env);
    expect((await item(env, ann.token, id)).stage).toBe("saved");
    advance(MINUTE + 1000);
    await runMinute(env);
    const got = await item(env, ann.token, id);
    expect(got).toMatchObject({ stage: "triaged", expiry_days: 30 });
    expect(got.dispatch_to.name).toBe("Built-in assistant");
    expect(await db(env, "SELECT * FROM notify_batches")).toHaveLength(0);
  });

  it("K8 triage: a model that fails or times out leaves the items to the defaults", async () => {
    const base = makeEnv();
    const ann = await signIn(base);
    const id = await saveText(base, ann.token, "The model is down.");
    const env = makeEnv({ ...LLM, OUTBOUND: async () => new Response("overloaded", { status: 529 }) });
    await runMinute(env);
    expect((await item(env, ann.token, id)).stage).toBe("saved");
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toHaveLength(0);
    advance(10 * MINUTE + 1000);
    await runMinute(env);
    expect((await item(env, ann.token, id)).stage).toBe("triaged");
  });

  it("K8 triage: at most 200 items per user per day go to the model; the rest get defaults from the core at once", async () => {
    const calls: any[] = [];
    const base = makeEnv();
    const ann = await signIn(base);
    // The sorting step sets a retention only when the user's rules give it grounds to.
    await base.DB.prepare("UPDATE users SET rules = 'Keep thoughts for 90 days.' WHERE id = ?").bind(ann.userId).run();
    await base.DB.prepare("INSERT INTO daily_caps (user_id, day, kind, n) VALUES (?, '2026-11-24', 'triage', 198)").bind(ann.userId).run();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(await saveText(base, ann.token, `Thought number ${i}.`));
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub((req) => JSON.parse(req.messages[0].content).items.map((x: any) => ({ item_id: x.item_id, expiry_days: 90 })), calls) });
    await runMinute(env);
    // Two were left under the cap and went to the model; the cap is now full.
    const first = await Promise.all(ids.map((id) => item(env, ann.token, id)));
    expect(first.filter((x) => x.expiry_days === 90)).toHaveLength(2);
    expect(JSON.parse(calls[0].request.messages[0].content).items).toHaveLength(2);
    await runMinute(env);
    // (The built-in worker also calls the stub for analyses; only the sorting calls count here.)
    expect(calls.filter((c) => c.request.system.startsWith("You sort"))).toHaveLength(1);
    const second = await Promise.all(ids.map((id) => item(env, ann.token, id)));
    expect(second.every((x) => x.stage === "triaged")).toBe(true);
    expect(second.filter((x) => x.expiry_days === 30)).toHaveLength(2);
    expect((await db(env, "SELECT n FROM daily_caps WHERE kind = 'triage'"))[0].n).toBe(200);
  });

  it("K8 triage: a tag the user edited is not overwritten by triage", async () => {
    const base = makeEnv();
    const { ann, helper } = await withHelper(base);
    const other = await connectAssistant(base, ann, { name: "Second", kind: "scheduled", steps: ["analysis"] });
    const id = await saveText(base, ann.token, "The user decides this one.");
    const patched = await call(base, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { dispatch_to: other.assistantId, expiry_days: 90 } });
    expect(patched.status).toBe(200);
    const env = makeEnv({ ...LLM, OUTBOUND: modelStub(() => [{ item_id: id, assistant: "Helper", expiry_days: 7 }]) });
    await runMinute(env);
    const got = await item(env, ann.token, id);
    expect(got).toMatchObject({ stage: "triaged", expiry_days: 90, days_left: 90, dispatch_to: { id: other.assistantId, name: "Second" } });
    expect(got.tags).toEqual(expect.arrayContaining(["assistant:Second", "expiry:90"]));
    // The same holds for the core's own defaults.
    const id2 = await saveText(base, ann.token, "Another one the user decides.");
    await call(base, "PATCH", `/v1/items/${id2}`, { token: ann.token, body: { expiry_days: 365 } });
    advance(10 * MINUTE + 1000);
    await runMinute(base);
    expect(await item(base, ann.token, id2)).toMatchObject({ expiry_days: 365, dispatch_to: { id: helper.assistantId } });
  });

  it("K8 triage: the user can only hand an item to an assistant in their list, and keep it at most 365 days", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Limits.");
    expect((await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { dispatch_to: "ast_unknown" } })).status).toBe(400);
    expect((await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { expiry_days: 366 } })).status).toBe(400);
    expect((await call(env, "PATCH", `/v1/items/${id}`, { token: ann.token, body: { title: "New title" } })).json.title).toBe("Limits.");
  });

  it("K8 triage: a connecting assistant cannot be granted the triage step", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const reg = await call(env, "POST", "/oauth/register", { body: { redirect_uris: ["https://assistant.example/callback"] } });
    const q = new URLSearchParams({ response_type: "code", client_id: reg.json.client_id, redirect_uri: "https://assistant.example/callback", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "triage" });
    expect((await call(env, "GET", `/oauth/authorize?${q}`)).status).toBe(400);
    const helper = await connectAssistant(env, ann, { name: "Helper" });
    expect((await call(env, "POST", "/v1/assistant/claims", { token: helper.access, body: { kind: "triage" } })).status).toBe(403);
  });
});
