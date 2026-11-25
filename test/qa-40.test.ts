import { describe, expect, it } from "vitest";
import { runMinute } from "../src/cron";
import { call, idem, makeEnv, signIn } from "./helpers";

const LLM = { LLM_API_KEY: "test-key", LLM_BASE_URL: "https://model.test" };

/** A model that always wants to keep things for 7 days. */
function eager(calls: string[]) {
  return async (_url: string, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    calls.push(request.system);
    if (request.system.startsWith("You sort")) {
      const items = JSON.parse(request.messages[0].content).items as { item_id: string }[];
      return Response.json({ type: "message", model: "m", content: [{ type: "text", text: JSON.stringify(items.map((i) => ({ item_id: i.item_id, expiry_days: 7 }))) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }
    return Response.json({ type: "message", model: "m", content: [{ type: "text", text: JSON.stringify({ summary: "s", key_fact: "k", points: [], verdict: "skippable" }) }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
}

describe("QA #40: the sorting step does not invent a retention", () => {
  it("QA #40: with no rules from the user a new item keeps the default 30 days, whatever the model suggests", async () => {
    const calls: string[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: eager(calls) });
    const ann = await signIn(env);
    const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "A short note saved from Today." }, idem: idem() });
    await runMinute(env);
    const item = (await call(env, "GET", `/v1/items/${saved.json.item_id}`, { token: ann.token })).json;
    expect(item.stage).not.toBe("saved");
    expect(item).toMatchObject({ expiry_days: 30, retention_set_by: "default" });
  });

  it("QA #40: once the user has written rules, the sorting step may set the retention", async () => {
    const calls: string[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: eager(calls) });
    const ann = await signIn(env);
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { rules: "Keep short notes for 7 days." } });
    const saved = await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text: "Another short note." }, idem: idem() });
    await runMinute(env);
    const item = (await call(env, "GET", `/v1/items/${saved.json.item_id}`, { token: ann.token })).json;
    expect(item).toMatchObject({ expiry_days: 7, retention_set_by: "triage" });
    expect(calls.find((s) => s.startsWith("You sort"))).toContain("Never choose on your own judgement");
  });
});
