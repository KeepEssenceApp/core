// internal-qa #99: the sort (triage) keeps the light model, analysis and the daily digest use the stronger one. Which model and
// how hard it thinks is decided per job; what goes out is captured here from the stand-in gateway. Every text is made up and
// no test reaches a real gateway.
import { describe, expect, it } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { modelFor, askModel, ROLE_DEFAULTS } from "../src/services/model";
import { ADMIN, builtinModel, call, db, HOUR_MS, LLM, makeEnv, saveText, signIn, type Outbound } from "./helpers";

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const jobOf = (system: string) => (system.startsWith("You sort") ? "triage" : system.startsWith("You analyse") ? "analysis" : "digest");
/** What each captured request asked for, in order: the job, the model, and the effort field (absent: undefined). */
const asked = (calls: any[]) => calls.map((c) => [jobOf(c.request.system), c.request.model, c.request.output_config?.effort]);

/** One saved text, triaged and analysed, then the digest written after 21:00: all three jobs, in order. */
async function allThreeJobs(extra: Parameters<typeof makeEnv>[0] = {}) {
  const calls: any[] = [];
  const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls), ...extra });
  const ann = await signIn(env);
  await saveText(env, ann.token, "Green tea likes cooler water. Steep it for two minutes.", "Brewing green tea");
  await runMinute(env);
  advance(8 * HOUR_MS + 61 * MINUTE); // 21:01 in the account's time zone
  await runMinute(env);
  return { env, calls };
}

describe("which model a job asks for, and how hard it thinks", () => {
  it("nothing configured: the sort is Haiku at low effort, analysis and digest are Sonnet at medium", () => {
    expect(modelFor(makeEnv(), "triage")).toEqual({ model: HAIKU, effort: "low" });
    expect(modelFor(makeEnv(), "worker")).toEqual({ model: SONNET, effort: "medium" });
    expect(ROLE_DEFAULTS).toEqual({ triage: { model: HAIKU, effort: "low" }, worker: { model: SONNET, effort: "medium" } });
  });

  it("a job's own variable wins; the old LLM_MODEL stands in for any job that has none (an existing set-up keeps its one model)", () => {
    expect(modelFor(makeEnv({ LLM_MODEL_TRIAGE: "t-model", LLM_MODEL_WORKER: "w-model", LLM_MODEL: "old" }), "triage").model).toBe("t-model");
    expect(modelFor(makeEnv({ LLM_MODEL_TRIAGE: "t-model", LLM_MODEL_WORKER: "w-model", LLM_MODEL: "old" }), "worker").model).toBe("w-model");
    expect(modelFor(makeEnv({ LLM_MODEL: "old" }), "triage").model).toBe("old");
    expect(modelFor(makeEnv({ LLM_MODEL: "old" }), "worker").model).toBe("old");
    expect(modelFor(makeEnv({ LLM_MODEL: "old", LLM_MODEL_WORKER: "w-model" }), "triage").model).toBe("old");
  });

  it("an empty or blank value counts as not set", () => {
    expect(modelFor(makeEnv({ LLM_MODEL_TRIAGE: "", LLM_MODEL_WORKER: "   ", LLM_MODEL: "" }), "triage").model).toBe(HAIKU);
    expect(modelFor(makeEnv({ LLM_MODEL_TRIAGE: "", LLM_MODEL_WORKER: "   ", LLM_MODEL: "" }), "worker").model).toBe(SONNET);
  });

  it("the effort is low, medium or high; anything else is the job's default", () => {
    expect(modelFor(makeEnv({ LLM_EFFORT_WORKER: "high" }), "worker").effort).toBe("high");
    expect(modelFor(makeEnv({ LLM_EFFORT_WORKER: " Low " }), "worker").effort).toBe("low");
    expect(modelFor(makeEnv({ LLM_EFFORT_TRIAGE: "medium" }), "triage").effort).toBe("medium");
    for (const bad of ["", "max", "extreme", "1"]) {
      expect(modelFor(makeEnv({ LLM_EFFORT_WORKER: bad }), "worker").effort).toBe("medium");
      expect(modelFor(makeEnv({ LLM_EFFORT_TRIAGE: bad }), "triage").effort).toBe("low");
    }
  });
});

describe("what the three jobs send", () => {
  it("nothing configured: triage goes out as Haiku/low, analysis and digest as Sonnet/medium", async () => {
    const { calls } = await allThreeJobs();
    expect(asked(calls)).toEqual([
      ["triage", HAIKU, "low"],
      ["analysis", SONNET, "medium"],
      ["digest", SONNET, "medium"],
    ]);
  });

  it("the shipped configuration (the variables in wrangler.toml) sends the same", async () => {
    const { calls } = await allThreeJobs({ LLM_MODEL_TRIAGE: HAIKU, LLM_EFFORT_TRIAGE: "low", LLM_MODEL_WORKER: SONNET, LLM_EFFORT_WORKER: "medium" });
    expect(asked(calls)).toEqual([
      ["triage", HAIKU, "low"],
      ["analysis", SONNET, "medium"],
      ["digest", SONNET, "medium"],
    ]);
  });

  it("an old configuration with only LLM_MODEL keeps one model for every job (the efforts are the jobs' own)", async () => {
    const { calls } = await allThreeJobs({ LLM_MODEL: "my-gateway-model" });
    expect(asked(calls)).toEqual([
      ["triage", "my-gateway-model", "low"],
      ["analysis", "my-gateway-model", "medium"],
      ["digest", "my-gateway-model", "medium"],
    ]);
  });

  it("the variables set each job apart (a different model and effort for each)", async () => {
    const { calls } = await allThreeJobs({ LLM_MODEL_TRIAGE: "t-model", LLM_EFFORT_TRIAGE: "medium", LLM_MODEL_WORKER: "w-model", LLM_EFFORT_WORKER: "high" });
    expect(asked(calls)).toEqual([
      ["triage", "t-model", "medium"],
      ["analysis", "w-model", "high"],
      ["digest", "w-model", "high"],
    ]);
  });

  it("the usage on record tells the two models apart, and the analysis is signed with the one that wrote it", async () => {
    const { env } = await allThreeJobs();
    const rows = await db(env, "SELECT kind, model, SUM(calls) AS calls FROM usage_records GROUP BY kind, model ORDER BY kind");
    expect(rows).toEqual([
      { kind: "analysis", model: SONNET, calls: 1 },
      { kind: "digest", model: SONNET, calls: 1 },
      { kind: "triage", model: HAIKU, calls: 1 },
    ]);
  });
});

describe("the gateway that does not know the effort field", () => {
  const REQ = { system: "s", content: "c", maxTokens: 100, timeoutMs: 1000 };
  const ok = () => Response.json({ model: SONNET, stop_reason: "end_turn", content: [{ type: "text", text: "x" }], usage: { input_tokens: 5, output_tokens: 2 } });

  it("a 400 is answered once, without the field, for the same model; no more than the two requests", async () => {
    const bodies: any[] = [];
    const out: Outbound = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      return body.output_config ? new Response("unknown field", { status: 400 }) : ok();
    };
    const a = await askModel(makeEnv({ ...LLM, OUTBOUND: out }), { ...REQ, role: "worker" });
    expect(bodies.map((b) => [b.model, b.output_config?.effort])).toEqual([
      [SONNET, "medium"],
      [SONNET, undefined],
    ]);
    expect(a.reply).toMatchObject({ text: "x", model: SONNET, effortRefused: true });
  });

  it("a 400 that stays a 400 without the field ends there: two requests, no third, and no reply", async () => {
    let n = 0;
    const out: Outbound = async () => (n++, new Response("no", { status: 400 }));
    const a = await askModel(makeEnv({ ...LLM, OUTBOUND: out }), { ...REQ, role: "worker" });
    expect(n).toBe(2);
    expect(a).toEqual({ reply: null, cost: null, failure: "model answered 400" });
  });

  it("a request told not to send the field (an earlier one found it refused) sends none, and is not asked twice", async () => {
    const bodies: any[] = [];
    const out: Outbound = async (_url, init) => (bodies.push(JSON.parse(String(init?.body))), ok());
    await askModel(makeEnv({ ...LLM, OUTBOUND: out }), { ...REQ, role: "worker", noEffort: true });
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config).toBeUndefined();
    expect(bodies[0].model).toBe(SONNET);
  });
});

describe("the admin overview says what each job uses", () => {
  const overview = async (env: any) => (await call(env, "GET", "/admin/overview", { token: ADMIN })).json.config;

  it("two models: `model` names both (not the sort's as if it were the analysis's), and `models` has each with its effort", async () => {
    const config = await overview(makeEnv());
    expect(config.model).toBe(`${HAIKU} (triage), ${SONNET} (analysis, digest)`);
    expect(config.models).toEqual({ triage: { model: HAIKU, effort: "low" }, worker: { model: SONNET, effort: "medium" } });
  });

  it("one model for both: `model` is that one name, as before", async () => {
    const config = await overview(makeEnv({ LLM_MODEL: "old" }));
    expect(config.model).toBe("old");
    expect(config.models).toEqual({ triage: { model: "old", effort: "low" }, worker: { model: "old", effort: "medium" } });
  });
});
