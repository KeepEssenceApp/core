import { describe, expect, it } from "vitest";
import { advance, DAY, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { analysed, analysis, builtinModel, call, claim, coreTriage, db, HOUR_MS, idem, LLM, makeEnv, refresh, saveText, signIn, submit, withHelper } from "./helpers";

const item = async (env: any, token: string, id: string) => (await call(env, "GET", `/v1/items/${id}`, { token })).json;
const kinds = (calls: any[]) => calls.map((c) => (c.request.system.startsWith("You sort") ? "triage" : c.request.system.startsWith("You analyse") ? "analysis" : "digest"));

describe("K11 built-in worker", () => {
  it("K11 worker: a user without an assistant of their own gets a four-field analysis signed by the built-in assistant", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Green tea likes cooler water. Steep it for two minutes.", "Brewing green tea");
    await runMinute(env);
    expect(kinds(calls)).toEqual(["triage", "analysis"]);
    const got = await item(env, ann.token, id);
    expect(got.stage).toBe("analysed");
    expect(got.analysis).toMatchObject({ unavailable: false, summary: "About: Brewing green tea", key_fact: "Text, short", points: ["First point.", "Second point."], verdict: "worth_deep_dive" });
    expect(got.analysis.assistant.name).toBe("Built-in assistant");
    // The model was asked to write in the user's language and got the content.
    expect(calls[1].request.system).toContain("English");
    expect(calls[1].request.messages[0].content).toContain("Steep it for two minutes");
    // Usage of built-in assistants is measured by the core, not self-reported.
    const usage = (await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants;
    expect(usage.every((u: any) => u.self_reported === false)).toBe(true);
    expect(usage.find((u: any) => u.name === "Built-in assistant")).toMatchObject({ calls: 1, input_tokens: 120, output_tokens: 40, items: 1 });
    // It appears to the user as the built-in assistant, recently seen.
    const status = (await call(env, "GET", "/v1/status", { token: ann.token })).json;
    expect(status.assistants).toHaveLength(1);
    expect(status.assistants[0]).toMatchObject({ name: "Built-in assistant", state: "recent" });
    expect(status.waiting).toBe(0);
  });

  it("K11 worker: it writes in the user's language", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env, "li@example.com", "zh");
    await saveText(env, ann.token, "绿茶要用低一点的水温。");
    await runMinute(env);
    expect(calls[1].request.system).toContain("简体中文");
    expect((await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants[0].name).toBe("内置助手");
  });

  it("K11 worker: when the user chose their own assistant for analysis, the built-in one does not take the work", async () => {
    const calls: any[] = [];
    const base = makeEnv();
    const { ann, helper } = await withHelper(base);
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const id = await saveText(env, ann.token, "This one is for my own assistant.");
    await runMinute(env);
    await runMinute(env);
    expect(kinds(calls)).toEqual(["triage"]);
    expect(await item(env, ann.token, id)).toMatchObject({ stage: "triaged", dispatch_to: { id: helper.assistantId } });
    const c = await claim(env, helper.access, "analysis");
    expect(c.work.map((w: any) => w.ref)).toEqual([id]);
    await submit(env, helper.access, c.claim_id, [analysis(id)]);
    expect((await item(env, ann.token, id)).analysis.assistant).toEqual({ id: helper.assistantId, name: "Helper" });
  });

  it("K11 worker: a single item the user hands to the built-in assistant is done by it, the rest stay with their own", async () => {
    const calls: any[] = [];
    const base = makeEnv();
    const { ann } = await withHelper(base);
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const worker = (await call(env, "GET", "/v1/assistants", { token: ann.token })).json.assistants.find((a: any) => a.built_in);
    const mine = await saveText(env, ann.token, "For my own assistant.");
    const theirs = await saveText(env, ann.token, "For the built-in assistant.");
    await call(env, "PATCH", `/v1/items/${theirs}`, { token: ann.token, body: { dispatch_to: worker.id } });
    await runMinute(env);
    expect((await item(env, ann.token, theirs)).analysis.assistant.id).toBe(worker.id);
    expect((await item(env, ann.token, mine)).analysis).toBeNull();
  });

  it("K11 worker: without a model key the built-in assistants do nothing, and nothing fails", async () => {
    const env = makeEnv({ OUTBOUND: async () => { throw new Error("no outbound call expected"); } });
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Nobody is home.");
    await runMinute(env);
    await coreTriage(env);
    expect(await item(env, ann.token, id)).toMatchObject({ stage: "triaged", analysis: null });
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json).toMatchObject({ waiting: 1, oldest_waiting_deleted_on: "2026-12-24" });
  });

  it("K11 worker: an answer that does not fit the four fields is not handed in; the item is tried again", async () => {
    let good = false;
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: (input) => (good ? { summary: "s".repeat(90), key_fact: "k", points: ["1", "2", "3", "4", "5"], verdict: "good_to_know" } : "I would rather write an essay about " + input.title) }) });
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "A difficult text.");
    await runMinute(env);
    expect((await item(env, ann.token, id)).analysis).toBeNull();
    expect(await db(env, "SELECT id FROM items WHERE claim_id IS NOT NULL")).toHaveLength(0);
    good = true;
    await runMinute(env);
    const a = (await item(env, ann.token, id)).analysis;
    // Too long a summary and too many points are cut to the limits before handing in.
    expect([...a.summary]).toHaveLength(60);
    expect(a.points).toEqual(["1", "2", "3"]);
  });

  it("K11 worker: content that could not be fetched is reported as such, without asking the model", async () => {
    const calls: any[] = [];
    const model = builtinModel(calls);
    const env = makeEnv({ ...LLM, OUTBOUND: async (url, init) => (url.includes("model.test") ? model(url, init) : new Response("gone", { status: 404 })) });
    const ann = await signIn(env);
    const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/gone" }, idem: idem() });
    await runMinute(env);
    expect(kinds(calls)).toEqual(["triage"]);
    expect((await item(env, ann.token, saved.json.item_id)).analysis).toMatchObject({ unavailable: true, summary: "Content could not be fetched" });
  });

  it("K11 worker: at most 200 analyses per user per day", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    await env.DB.prepare("INSERT INTO daily_caps (user_id, day, kind, n) VALUES (?, '2026-11-24', 'analysis', 199)").bind(ann.userId).run();
    const ids = [await saveText(env, ann.token, "One."), await saveText(env, ann.token, "Two.")];
    await runMinute(env);
    await runMinute(env);
    const done = (await Promise.all(ids.map((id) => item(env, ann.token, id)))).filter((x) => x.analysis);
    expect(done).toHaveLength(1);
    expect(kinds(calls).filter((k) => k === "analysis")).toHaveLength(1);
    // The next day it goes on.
    advance(DAY);
    await runMinute(env);
    expect((await Promise.all(ids.map((id) => item(env, ann.token, id)))).filter((x) => x.analysis)).toHaveLength(2);
  });
});

describe("K12 daily digest", () => {
  it("K12 digest: it becomes due only after 21:00 in the user's time zone", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    const ann = await signIn(env);
    const id = await saveText(env, ann.token, "Green tea likes cooler water.", "Brewing green tea");
    await runMinute(env); // 12:00 in Shanghai: triage and analysis
    advance(8 * HOUR_MS + 55 * MINUTE); // 20:55
    await runMinute(env);
    expect(kinds(calls)).not.toContain("digest");
    expect((await call(env, "GET", "/v1/digests/latest", { token: ann.token })).status).toBe(404);
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.no_digest_reason).toBe("not_yet_time");
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items).toHaveLength(1);

    advance(6 * MINUTE); // 21:01
    await runMinute(env);
    expect(kinds(calls).filter((k) => k === "digest")).toHaveLength(1);
    const digest = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    // Four fixed parts, in this order of the contract: summary, worth, rest, question.
    expect(digest).toMatchObject({ day: "2026-11-24", read: false, summary: "You saved 1 things today.", question: "What would you brew tomorrow?", counts: { saved: 1, worth: 1 }, rest: [], previous_day: null, next_day: null });
    expect(digest.worth).toEqual([{ item_id: id, title: "Brewing green tea", line: "Worth it: Brewing green tea", verdict: "worth_deep_dive", available: true, in_queue: false }]);
    expect(digest.assistant.name).toBe("Built-in assistant");
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.no_digest_reason).toBeNull();
    // The item moved from "today" to "digested".
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items).toHaveLength(0);
    expect((await call(env, "GET", "/v1/items?state=digested", { token: ann.token })).json.items.map((i: any) => i.id)).toEqual([id]);
    // One digest a day: running again changes nothing.
    await runMinute(env);
    expect(kinds(calls).filter((k) => k === "digest")).toHaveLength(1);
    expect((await call(env, "GET", "/v1/digests", { token: ann.token })).json.digests).toEqual([{ day: "2026-11-24", read: false }]);
  });

  it("K12 digest: a day without analyses gets no digest", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: () => "not json" }) });
    const ann = await signIn(env);
    await saveText(env, ann.token, "Saved but never analysed.");
    advance(10 * HOUR_MS);
    await runMinute(env);
    expect(kinds(calls)).not.toContain("digest");
    expect((await call(env, "GET", "/v1/digests", { token: ann.token })).json.digests).toEqual([]);
    expect((await call(env, "GET", "/v1/status", { token: ann.token })).json.no_digest_reason).toBe("nothing_analysed");
  });

  it("K12 digest: a missed day is merged into the next digest, not written late on its own", async () => {
    const calls: any[] = [];
    const off = makeEnv();
    const { ann, helper } = await withHelper(off, ["analysis"]);
    const [first] = await analysed(off, ann, helper, ["Day one thought."]);
    advance(DAY); // the next day, 12:10 — nobody wrote yesterday's digest
    await refresh(off, helper);
    const [second] = await analysed(off, ann, helper, ["Day two thought."]);
    advance(9 * HOUR_MS); // 21:20 on day two
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    await runMinute(env);
    const list = (await call(env, "GET", "/v1/digests", { token: ann.token })).json.digests;
    expect(list).toEqual([{ day: "2026-11-25", read: false }]);
    const digest = (await call(env, "GET", "/v1/digests/2026-11-25", { token: ann.token })).json;
    expect(digest.worth.map((w: any) => w.item_id).sort()).toEqual([first, second].sort());
    expect(digest.counts.saved).toBe(2);
    expect(JSON.parse(calls.find((c) => c.request.system.startsWith("You write")).request.messages[0].content).covers).toEqual(["2026-11-24", "2026-11-25"]);
    expect((await call(env, "GET", "/v1/digests/2026-11-24", { token: ann.token })).status).toBe(404);
  });

  it("K12 digest: what is analysed after the day's digest goes into the next day's", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel() });
    const ann = await signIn(env);
    await saveText(env, ann.token, "Morning thought.");
    await runMinute(env);
    advance(9 * HOUR_MS + 5 * MINUTE);
    await runMinute(env); // digest of the 24th at 21:05
    const late = await saveText(env, ann.token, "Late evening thought.");
    await runMinute(env); // analysed at 21:05, after the digest
    advance(2 * HOUR_MS);
    await runMinute(env);
    expect((await call(env, "GET", "/v1/digests", { token: ann.token })).json.digests).toHaveLength(1);
    expect((await call(env, "GET", "/v1/items?state=today", { token: ann.token })).json.items.map((i: any) => i.id)).toEqual([late]);
    advance(DAY);
    await runMinute(env);
    const digest = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    expect(digest).toMatchObject({ day: "2026-11-25", previous_day: "2026-11-24" });
    expect(digest.worth.map((w: any) => w.item_id)).toEqual([late]);
  });

  it("K12 digest: 'read' is only a mark", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel() });
    const ann = await signIn(env);
    await saveText(env, ann.token, "A thought.");
    await runMinute(env);
    advance(9 * HOUR_MS + 5 * MINUTE);
    await runMinute(env);
    const before = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    const items = await db(env, "SELECT * FROM items");
    expect((await call(env, "POST", "/v1/digests/2026-11-24/read", { token: ann.token })).status).toBe(204);
    const after = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    expect(after).toEqual({ ...before, read: true });
    expect(await db(env, "SELECT * FROM items")).toEqual(items);
    expect((await call(env, "POST", "/v1/digests/2026-11-20/read", { token: ann.token })).status).toBe(404);
  });

  it("K12 digest: the user's own digest assistant gets the work after 21:00, with the user's marks, and the built-in one stays away", async () => {
    const calls: any[] = [];
    const base = makeEnv();
    const { ann, helper } = await withHelper(base);
    const [a, b] = await analysed(base, ann, helper, ["First thought.", "Second thought."]);
    await call(base, "PUT", `/v1/items/${a}/signal`, { token: ann.token, body: { signal: "not_interested" } });
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls) });
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).json.work).toEqual([]);
    advance(8 * HOUR_MS + 55 * MINUTE); // 21:05
    await runMinute(env);
    expect(kinds(calls)).toEqual([]);
    // The access credential ran out hours ago; refresh it (no user involved).
    const tok = await call(env, "POST", "/oauth/token", { form: { grant_type: "refresh_token", refresh_token: helper.refresh, client_id: helper.clientId } });
    const access = tok.json.access_token;
    const work = (await call(env, "GET", "/v1/assistant/work", { token: access })).json.work;
    expect(work).toEqual([{ kind: "digest", count: 1, oldest_due_at: "2026-11-24T13:00:00.000Z" }]);
    const c = await claim(env, access, "digest");
    expect(c.work).toEqual([{ ref: "2026-11-24", title: "2026-11-24" }]);
    expect((await claim(env, access, "digest")).work).toEqual([]);
    const ctx = (await call(env, "GET", "/v1/assistant/digests/2026-11-24/context", { token: access })).json;
    expect(ctx.day).toBe("2026-11-24");
    expect(ctx.analyses.find((x: any) => x.item_id === a)).toMatchObject({ signal: "not_interested", in_queue: false, verdict: "worth_deep_dive" });
    // Fields are checked: a line for an item the digest does not cover is refused.
    const bad = await submit(env, access, c.claim_id, [{ kind: "digest", day: "2026-11-24", summary: "Two thoughts.", question: "Why?", worth: [{ item_id: "itm_other", line: "x" }] }]);
    expect(bad.json.error.code).toBe("invalid_result");
    expect((await submit(env, access, c.claim_id, [{ kind: "digest", day: "2026-11-24", summary: "Two thoughts.", question: "Why?", tags: ["x"] }])).status).toBe(400);
    const ok = await submit(env, access, c.claim_id, [{ kind: "digest", day: "2026-11-24", summary: "Two thoughts.", question: "Why?", worth: [{ item_id: b, line: "The second one matters." }] }]);
    expect(ok.json.outcomes).toEqual([{ ref: "2026-11-24", accepted: true }]);
    const digest = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    expect(digest.assistant).toEqual({ id: helper.assistantId, name: "Helper" });
    expect(digest.worth.map((w: any) => w.item_id)).toEqual([b]);
    expect(digest.rest.map((r: any) => r.item_id)).toEqual([a]);
  });
});
