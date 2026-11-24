import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { builtinActor } from "../src/services/accounts";
import { claimWork } from "../src/services/work";
import { analysed, analysis, call, claim, coreTriage, db, idem, makeEnv, saveText, signIn, submit, withHelper } from "./helpers";

async function seed(env: any, ann: any, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await saveText(env, ann.token, `Thought number ${i} about tea.`));
  await coreTriage(env);
  return ids;
}

describe("K21 work question", () => {
  it("K21 work: 'is there work' is one plain GET, no tool call and no model", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).json).toEqual({ work: [] });
    await seed(env, ann, 3);
    const r = await call(env, "GET", "/v1/assistant/work", { token: helper.access });
    expect(r.status).toBe(200);
    expect(r.json.work).toHaveLength(1);
    expect(r.json.work[0]).toMatchObject({ kind: "analysis", count: 3 });
    expect(r.json.work[0].oldest_due_at).toMatch(/^2026-12-24T/);
    expect((await call(env, "GET", "/v1/assistant/work")).status).toBe(401);
  });

  it("K21 work: an assistant is only told about work that is its own", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await seed(env, ann, 2); // these go to the built-in assistant
    const { connectAssistant } = await import("./helpers");
    const other = await connectAssistant(env, ann, { name: "Other", kind: "scheduled", steps: ["analysis", "digest", "deep_read"] });
    expect((await call(env, "GET", "/v1/assistant/work", { token: other.access })).json.work).toEqual([]);
    expect((await claim(env, other.access, "analysis")).work).toEqual([]);
  });
});

describe("K9 claims", () => {
  it("K9 claims: two assistants cannot hold the same item", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    for (let i = 0; i < 8; i++) await saveText(env, ann.token, `Thought ${i}.`);
    // Two assistants allowed to triage ask at the same moment.
    const first = (await builtinActor(env, ann.userId, "dispatch"))!;
    await env.DB.prepare("INSERT INTO assistants (id, user_id, name, kind, steps, connected_at) VALUES ('ast_second', ?, 'Second sorter', 'scheduled', '[\"triage\"]', 0)").bind(ann.userId).run();
    const second = { ...first, assistantId: "ast_second", name: "Second sorter", builtIn: null };
    const [a, b] = await Promise.all([claimWork(env, first, "triage", 5), claimWork(env, second, "triage", 5)]);
    const refsA = a.work.map((w) => w.ref);
    const refsB = b.work.map((w) => w.ref);
    expect(refsA.length + refsB.length).toBe(8);
    expect(refsA.filter((r) => refsB.includes(r))).toEqual([]);
    const held = await db(env, "SELECT claim_id, COUNT(*) AS n FROM items GROUP BY claim_id");
    expect(held.map((h) => h.n).sort()).toEqual([3, 5]);
  });

  it("K9 claims: the same assistant asking twice at once gets two disjoint claims", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await seed(env, ann, 6);
    const [a, b] = await Promise.all([claim(env, helper.access, "analysis", 4), claim(env, helper.access, "analysis", 4)]);
    const all = [...a.work, ...b.work].map((w: any) => w.ref);
    expect(all).toHaveLength(6);
    expect(new Set(all).size).toBe(6);
    expect((await claim(env, helper.access, "analysis")).work).toEqual([]);
  });

  it("K9 claims: at most 10 pieces per claim", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await seed(env, ann, 12);
    expect((await call(env, "POST", "/v1/assistant/claims", { token: helper.access, body: { kind: "analysis", limit: 11 } })).status).toBe(400);
    const c = await claim(env, helper.access, "analysis");
    expect(c.work).toHaveLength(10);
    expect(c.work[0].title).toBe("Thought number 0 about tea.");
    expect((await claim(env, helper.access, "analysis")).work).toHaveLength(2);
  });

  it("K9 claims: a claim lasts 30 minutes, then the work goes back by itself", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await seed(env, ann, 2);
    const c = await claim(env, helper.access, "analysis");
    expect(Date.parse(c.expires_at) - (await import("../src/clock")).now()).toBe(30 * MINUTE);
    advance(29 * MINUTE);
    expect((await claim(env, helper.access, "analysis")).work).toEqual([]);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).json.work).toEqual([]);
    advance(MINUTE + 1000);
    expect((await call(env, "GET", "/v1/assistant/work", { token: helper.access })).json.work[0].count).toBe(2);
    expect((await claim(env, helper.access, "analysis")).work).toHaveLength(2);
  });

  it("K9 claims: only the holder can renew, and only while the claim is alive", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const { connectAssistant } = await import("./helpers");
    const other = await connectAssistant(env, ann, { name: "Other", kind: "scheduled", steps: ["analysis"] });
    await seed(env, ann, 1);
    const c = await claim(env, helper.access, "analysis");
    expect((await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/renew`, { token: other.access })).status).toBe(404);
    expect((await call(env, "DELETE", `/v1/assistant/claims/${c.claim_id}`, { token: other.access })).status).toBe(404);
    advance(10 * MINUTE);
    const renewed = await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/renew`, { token: helper.access });
    expect(renewed.status).toBe(200);
    advance(25 * MINUTE); // 35 minutes after claiming: still held thanks to the renewal
    expect((await claim(env, helper.access, "analysis")).work).toEqual([]);
    advance(6 * MINUTE);
    const late = await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/renew`, { token: helper.access });
    expect(late.status).toBe(409);
    expect(late.json.error.code).toBe("claim_lost");
  });

  it("K9 claims: releasing puts the work back at once", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await seed(env, ann, 2);
    const c = await claim(env, helper.access, "analysis");
    expect((await call(env, "DELETE", `/v1/assistant/claims/${c.claim_id}`, { token: helper.access })).status).toBe(204);
    expect((await claim(env, helper.access, "analysis")).work).toHaveLength(2);
  });

  it("K9 claims: handing the same piece in twice does not make a second copy", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [id] = await seed(env, ann, 1);
    const c = await claim(env, helper.access, "analysis");
    const key = idem();
    const first = await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/submit`, { token: helper.access, body: { results: [analysis(id)] }, idem: key });
    expect(first.json.outcomes).toEqual([{ ref: id, accepted: true }]);
    // Same key: the first answer is replayed. New key, same piece: accepted again, nothing new stored.
    const replay = await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/submit`, { token: helper.access, body: { results: [analysis(id)] }, idem: key });
    expect(replay.json).toEqual(first.json);
    const again = await submit(env, helper.access, c.claim_id, [analysis(id, { summary: "A different second attempt." })]);
    expect(again.json.outcomes).toEqual([{ ref: id, accepted: true }]);
    expect(await db(env, "SELECT summary FROM analyses")).toEqual([{ summary: "A short note on brewing tea." }]);
    expect((await call(env, "GET", "/v1/stats?days=1", { token: ann.token })).json.days[0].analysed).toBe(1);
    expect((await call(env, "POST", `/v1/assistant/claims/${c.claim_id}/submit`, { token: helper.access, body: { results: [analysis(id)] } })).json.error.code).toBe("idempotency_key_required");
  });

  it("K9 claims: a late hand-in is accepted unless another claim already handed that piece in", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [a, b] = await seed(env, ann, 2);
    const slow = await claim(env, helper.access, "analysis");
    advance(31 * MINUTE);
    // Nobody else did `a` yet: the late hand-in counts.
    expect((await submit(env, helper.access, slow.claim_id, [analysis(a)])).json.outcomes).toEqual([{ ref: a, accepted: true }]);
    // `b` was claimed again and handed in by the new claim; the old claim comes too late.
    const fast = await claim(env, helper.access, "analysis");
    expect(fast.work.map((w: any) => w.ref)).toEqual([b]);
    expect((await submit(env, helper.access, fast.claim_id, [analysis(b, { summary: "From the second claim." })])).json.outcomes[0].accepted).toBe(true);
    const late = await submit(env, helper.access, slow.claim_id, [analysis(b)]);
    expect(late.json.outcomes[0]).toMatchObject({ ref: b, accepted: false });
    expect(late.json.outcomes[0].reason).toContain("another claim");
    expect(await db(env, "SELECT summary FROM analyses WHERE item_id = ?", b)).toEqual([{ summary: "From the second claim." }]);
  });

  it("K9 claims: a piece that is not part of the claim is not accepted, and another assistant's claim is not found", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const { connectAssistant } = await import("./helpers");
    const other = await connectAssistant(env, ann, { name: "Other", kind: "scheduled", steps: ["analysis"] });
    const ids = await seed(env, ann, 2);
    const c = await claim(env, helper.access, "analysis", 1);
    const a = c.work[0].ref;
    const b = ids.find((i) => i !== a)!;
    const r = await submit(env, helper.access, c.claim_id, [analysis(a), analysis(b)]);
    expect(r.json.outcomes.map((o: any) => o.accepted)).toEqual([true, false]);
    expect((await submit(env, other.access, c.claim_id, [analysis(a)])).status).toBe(404);
  });
});

describe("K10 analysis fields", () => {
  it("K10 analysis: results are taken field by field and anything else is refused with the reason", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [id] = await seed(env, ann, 1);
    const c = await claim(env, helper.access, "analysis");
    const cases: [Record<string, unknown>, string][] = [
      [{ summary: "x".repeat(61) }, "at most 60 characters"],
      [{ summary: "茶".repeat(61) }, "at most 60 characters"],
      [{ points: ["one", "two", "three", "four"] }, "at most 3 entries"],
      [{ verdict: "brilliant" }, "worth_deep_dive, good_to_know, skippable"],
      [{ verdict: undefined }, "verdict is required"],
      [{ summary: undefined }, "summary is required"],
      [{ points: ["x".repeat(121)] }, "at most 120"],
      [{ tags: ["tea"] }, "tags"],
      [{ body: "free text instead of fields" }, "body"],
      [{ kind: "essay" }, "kind"],
    ];
    const wrongKind = await submit(env, helper.access, c.claim_id, [{ kind: "triage", item_id: id }]);
    expect(wrongKind.json.error).toMatchObject({ code: "invalid_result" });
    expect(wrongKind.json.error.message).toContain("the claim is for analysis");
    for (const [change, why] of cases) {
      const r = await submit(env, helper.access, c.claim_id, [analysis(id, change)]);
      expect(`${why} → ${r.status} ${r.json.error?.code}`).toBe(`${why} → 400 invalid_result`);
      expect(r.json.error.message).toContain(why);
    }
    expect(await db(env, "SELECT item_id FROM analyses")).toHaveLength(0);
    // 60 characters exactly, three points: fine. Characters are counted as a person counts them.
    const ok = await submit(env, helper.access, c.claim_id, [analysis(id, { summary: "茶".repeat(60), points: ["a", "b", "c"], related_hint: "Close to last week's note on water." })]);
    expect(ok.json.outcomes).toEqual([{ ref: id, accepted: true }]);
    const item = (await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json;
    expect(item.stage).toBe("analysed");
    expect(item.analysis).toMatchObject({ unavailable: false, summary: "茶".repeat(60), key_fact: "Text, 9 words", points: ["a", "b", "c"], verdict: "worth_deep_dive", related_hint: "Close to last week's note on water.", assistant: { id: helper.assistantId, name: "Helper" } });
  });

  it("K10 analysis: one bad result refuses the whole hand-in; nothing is stored", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    const [a, b] = await seed(env, ann, 2);
    const c = await claim(env, helper.access, "analysis");
    const r = await submit(env, helper.access, c.claim_id, [analysis(a), analysis(b, { points: ["1", "2", "3", "4"] })]);
    expect(r.status).toBe(400);
    expect(await db(env, "SELECT item_id FROM analyses")).toHaveLength(0);
  });

  it("K10 analysis: when the content could not be fetched, points and verdict are not accepted", async () => {
    const env = makeEnv({ OUTBOUND: async () => new Response("gone", { status: 404 }) });
    const { ann, helper } = await withHelper(env);
    const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "link", url: "https://example.org/gone" }, idem: idem() });
    await coreTriage(env);
    const c = await claim(env, helper.access, "analysis");
    const id = saved.json.item_id;
    const ctx = await call(env, "GET", `/v1/assistant/items/${id}/context?for=analysis`, { token: helper.access });
    expect(ctx.json.item.content_unavailable).toBe(true);
    for (const bad of [analysis(id), analysis(id, { unavailable: true }), { kind: "analysis", item_id: id, unavailable: true, verdict: "skippable" }, { kind: "analysis", item_id: id, unavailable: true, points: ["a"] }]) {
      const r = await submit(env, helper.access, c.claim_id, [bad]);
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe("invalid_result");
    }
    const ok = await submit(env, helper.access, c.claim_id, [{ kind: "analysis", item_id: id, unavailable: true }]);
    expect(ok.json.outcomes[0].accepted).toBe(true);
    const item = (await call(env, "GET", `/v1/items/${id}`, { token: ann.token })).json;
    expect(item.analysis).toMatchObject({ unavailable: true, summary: "Content could not be fetched" });
    expect(item.analysis.points).toBeUndefined();
    expect(item.analysis.verdict).toBeUndefined();
  });

  it("K10 analysis: usage is recorded with every hand-in and marked self-reported for a connected assistant", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    await analysed(env, ann, helper, ["One."]);
    const [id] = await seed(env, ann, 1);
    const c = await claim(env, helper.access, "analysis");
    await submit(env, helper.access, c.claim_id, [analysis(id)], { model: "some-model", input_tokens: 900, output_tokens: 80, calls: 2 });
    const usage = await call(env, "GET", "/v1/usage", { token: ann.token });
    expect(usage.json.assistants).toEqual([{ assistant_id: helper.assistantId, name: "Helper", calls: 2, input_tokens: 900, output_tokens: 80, items: 2, self_reported: true }]);
    expect(await db(env, "SELECT COUNT(*) AS n FROM usage_records")).toEqual([{ n: 2 }]);
  });
});
