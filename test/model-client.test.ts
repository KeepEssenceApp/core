// internal-qa #27 (QA's review of 3e751d1 / 316e20d): what a model call cost and whether its answer can be used are two
// facts, and the client says both. An answer that carries its usage but has no usable text (an empty one, a refusal) was
// paid for; a call that got no answer was not, and no cost is made up for it. Every body here is made up.
import { describe, expect, it } from "vitest";
import { askModel, callModel } from "../src/services/model";
import { LLM, makeEnv, type Outbound } from "./helpers";

const USAGE = { input_tokens: 120, output_tokens: 40 };
const REQ = { role: "triage" as const, system: "s", content: "c", maxTokens: 100, timeoutMs: 1000 };
const answering = (body: unknown, status = 200): Outbound => async () => Response.json(body, { status });
const text = (t: string, extra: Record<string, unknown> = {}) => ({ model: "m-test", stop_reason: "end_turn", content: [{ type: "text", text: t }], ...extra });

describe("the model client keeps the cost of an answer apart from whether it can be used", () => {
  it("an answer with no usable text but with its usage has a cost and no reply", async () => {
    const empty = await askModel(makeEnv({ ...LLM, OUTBOUND: answering({ model: "m-test", content: [], usage: USAGE }) }), REQ);
    expect(empty).toEqual({ reply: null, cost: { model: "m-test", inputTokens: 120, outputTokens: 40 }, failure: "reply is empty" });
    const blank = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(text("   ", { usage: USAGE })) }), REQ);
    expect(blank).toMatchObject({ reply: null, cost: { inputTokens: 120, outputTokens: 40 }, failure: "reply is empty" });
    const refusal = await askModel(makeEnv({ ...LLM, OUTBOUND: answering({ stop_reason: "refusal", content: [{ type: "text", text: "declined" }], usage: USAGE }) }), REQ);
    expect(refusal).toEqual({ reply: null, cost: { model: "claude-haiku-5-5", inputTokens: 120, outputTokens: 40 }, failure: "model refused" });
    const noContent = await askModel(makeEnv({ ...LLM, OUTBOUND: answering({ usage: USAGE }) }), REQ);
    expect(noContent).toMatchObject({ reply: null, cost: { inputTokens: 120, outputTokens: 40 }, failure: "reply has no content" });
  });

  it("an answer that says nothing about its usage has no cost: none is made up", async () => {
    for (const body of [{ content: [] }, { content: [], usage: {} }, { content: [], usage: { input_tokens: null, output_tokens: "x" } }, { stop_reason: "refusal", content: [] }, { error: { message: "busy" } }]) {
      const a = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(body) }), REQ);
      expect(`${JSON.stringify(body)} ${JSON.stringify(a.cost)} ${a.reply}`).toBe(`${JSON.stringify(body)} null null`);
    }
  });

  it("a call that got no answer has no cost, whatever its body says", async () => {
    const withUsage = { content: [], usage: USAGE };
    for (const status of [401, 403, 429, 500, 503]) {
      const a = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(withUsage, status) }), REQ);
      expect(`${status} ${a.cost} ${a.reply}`).toBe(`${status} null null`);
      expect(a.failure).toMatch(/credential refused|model answered/);
    }
    const down = await askModel(makeEnv({ ...LLM, OUTBOUND: async () => Promise.reject(new TypeError("network")) }), REQ);
    expect(down).toEqual({ reply: null, cost: null, failure: "request failed: TypeError" });
    const slow = await askModel(
      makeEnv({ ...LLM, OUTBOUND: (_u, init) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) }),
      { ...REQ, timeoutMs: 30 },
    );
    expect(slow).toEqual({ reply: null, cost: null, failure: "no reply within 30 ms" });
    expect(await askModel(makeEnv({}), REQ)).toEqual({ reply: null, cost: null, failure: "no credential" });
  });

  it("a usable answer is a reply and a cost, as before; one that is not JSON is still a usable reply with its usage", async () => {
    const a = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(text("not json", { usage: USAGE })) }), REQ);
    expect(a).toEqual({ reply: { text: "not json", model: "m-test", inputTokens: 120, outputTokens: 40 }, cost: { model: "m-test", inputTokens: 120, outputTokens: 40 } });
    // Cached prompt parts count as input; counts written as strings are counts.
    const cached = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(text("x", { usage: { input_tokens: 100, cache_creation_input_tokens: 10, cache_read_input_tokens: 5, output_tokens: "7" } })) }), REQ);
    expect(cached.reply).toMatchObject({ inputTokens: 115, outputTokens: 7 });
    // No usage at all: a usable answer is still a call, at no tokens (as it always was).
    const bare = await askModel(makeEnv({ ...LLM, OUTBOUND: answering(text("x")) }), REQ);
    expect(bare).toMatchObject({ reply: { text: "x", inputTokens: 0, outputTokens: 0 }, cost: { inputTokens: 0, outputTokens: 0 } });
  });

  it("the compatibility retry on a 400 costs what its own answer says, not the refused first try", async () => {
    let n = 0;
    const out: Outbound = async () => (n++ === 0 ? Response.json({ error: "unknown field", usage: USAGE }, { status: 400 }) : Response.json({ content: [], usage: { input_tokens: 7, output_tokens: 3 } }));
    const a = await askModel(makeEnv({ ...LLM, OUTBOUND: out }), REQ);
    expect(n).toBe(2);
    expect(a).toMatchObject({ reply: null, cost: { inputTokens: 7, outputTokens: 3 }, failure: "reply is empty" });
  });

  it("callModel, for the jobs that cannot use an answer they cannot read, is as it was: null, and why once", async () => {
    for (const [body, why] of [
      [{ content: [], usage: USAGE }, "reply is empty"],
      [{ stop_reason: "refusal", content: [], usage: USAGE }, "model refused"],
      [{ usage: USAGE }, "reply has no content"],
    ] as const) {
      const reasons: string[] = [];
      expect(await callModel(makeEnv({ ...LLM, OUTBOUND: answering(body) }), { ...REQ, onFailure: (r) => reasons.push(r) })).toBeNull();
      expect(reasons).toEqual([why]);
    }
    const reasons: string[] = [];
    expect(await callModel(makeEnv({ ...LLM, OUTBOUND: answering(text("fine", { usage: USAGE })) }), { ...REQ, onFailure: (r) => reasons.push(r) })).toMatchObject({ text: "fine", inputTokens: 120, outputTokens: 40 });
    expect(reasons).toEqual([]);
  });
});
