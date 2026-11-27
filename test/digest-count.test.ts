// core#3 / internal-qa #27: a daily digest's summary does not contradict its snapshot.
// The QA fixture: sixteen distinct analysed items, no worth rows, and a model whose summary says fifteen.
// Every item and every sentence here is made up.
import { describe, expect, it } from "vitest";
import { advance } from "../src/clock";
import { runMinute } from "../src/cron";
import { analysed, builtinModel, call, claim, db, HOUR_MS, LLM, makeEnv, refresh, submit, withHelper, type Outbound } from "./helpers";

const isDigest = (c: any) => c.request.system.startsWith("You write");
const contentOf = (c: any) => JSON.parse(typeof c.request.messages[0].content === "string" ? c.request.messages[0].content : c.request.messages[0].content[0].text);
const SKIPPABLE = { verdict: "skippable" };

/** A day with `n` analysed items and no worth rows (the helper marks them skippable), and the clock at 21:20. */
async function dayOf(n: number, lang?: string) {
  const off = makeEnv();
  const { ann, helper } = await withHelper(off, ["analysis"]);
  if (lang) await call(off, "PATCH", "/v1/settings", { token: ann.token, body: { lang } });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 8) {
    ids.push(...(await analysed(off, ann, helper, Array.from({ length: Math.min(8, n - i) }, (_, k) => `Thought number ${i + k + 1} about tea and brewing.`), SKIPPABLE)));
  }
  advance(9 * HOUR_MS);
  await refresh(off, helper); // the helper's credential lasts an hour
  return { off, ann, helper, ids };
}

const digestOf = async (env: any, token: string) => (await call(env, "GET", "/v1/digests/latest", { token })).json;
const lines = (d: any) => [...d.worth.map((w: any) => w.item_id), ...d.rest.map((r: any) => r.item_id)];

describe("core#3: the built-in assistant's digest agrees with its snapshot", () => {
  it("a summary that says 15 for 16 items is asked about once more, with the number; the second answer is the one stored", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({
      ...LLM,
      OUTBOUND: builtinModel(calls, {
        digest: (input) => ({ summary: calls.filter(isDigest).length === 1 ? "You saved 15 items today, mostly about tea." : `You saved ${input.total} items today, mostly about tea.`, worth: [], question: "What would you brew tomorrow?" }),
      }),
    });
    await runMinute(env);
    const asked = calls.filter(isDigest);
    expect(asked).toHaveLength(2);
    expect(contentOf(asked[0])).toMatchObject({ total: 16 });
    expect(contentOf(asked[0]).correction).toBeUndefined();
    expect(contentOf(asked[1])).toMatchObject({ total: 16 });
    expect(contentOf(asked[1]).correction).toMatch(/15.*16/);
    const d = await digestOf(env, ann.token);
    expect(d.summary).toBe("You saved 16 items today, mostly about tea.");
    // Header, lists and prose agree: sixteen distinct items.
    expect(d.counts.saved).toBe(16);
    expect(new Set(lines(d)).size).toBe(16);
    expect(lines(d)).toHaveLength(16);
  });

  it("a model that keeps saying 15 is asked twice and no more; the summary is then the snapshot's own sentence, and the model's question and nothing else of its summary is kept", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => ({ summary: "You saved 15 items today.", worth: [], question: "What would you brew tomorrow?" }) }) });
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    const d = await digestOf(env, ann.token);
    expect(d.summary).toBe("This daily digest covers 16 analyses.");
    expect(d.question).toBe("What would you brew tomorrow?");
    expect(d.counts.saved).toBe(16);
    expect(new Set(lines(d)).size).toBe(16);
    // One digest a day: the cron does not go on asking.
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    const usage = (await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant");
    expect(usage).toMatchObject({ calls: 2 });
  });

  it("in Chinese the fallback is in Chinese", async () => {
    const { ann } = await dayOf(16, "zh");
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => ({ summary: "今天存入了十五条。", worth: [], question: "明天想泡什么茶？" }) }) });
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    expect((await digestOf(env, ann.token)).summary).toBe("这份每日摘要汇总了 16 条解读。");
  });

  for (const [name, summary] of [["is right the first time", "You saved 16 items today."], ["states no number", "A day of tea and brewing notes."]] as const) {
    it(`a summary that ${name} is one call and is stored as written`, async () => {
      const { ann } = await dayOf(16);
      const calls: any[] = [];
      const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => ({ summary, worth: [], question: "What would you brew tomorrow?" }) }) });
      await runMinute(env);
      expect(calls.filter(isDigest)).toHaveLength(1);
      expect((await digestOf(env, ann.token)).summary).toBe(summary);
    });
  }

  it("an analysis that lands while the model is writing is counted: the model is asked again about the set as it is now", async () => {
    const { off, ann, helper } = await dayOf(16);
    const calls: any[] = [];
    const model = builtinModel(calls);
    let late = false;
    const outbound: Outbound = async (url, init) => {
      if (!late && String(init?.body).includes("You write the owner's daily digest")) {
        late = true;
        await analysed(off, ann, helper, ["A thought that came in while the digest was being written."], SKIPPABLE);
      }
      return model(url, init);
    };
    const env = makeEnv({ ...LLM, OUTBOUND: outbound });
    await runMinute(env);
    const asked = calls.filter(isDigest);
    expect(asked).toHaveLength(2);
    expect(contentOf(asked[0]).total).toBe(16);
    expect(contentOf(asked[1]).total).toBe(17);
    const d = await digestOf(env, ann.token);
    expect(d.summary).toBe("You saved 17 things today.");
    expect(d.counts.saved).toBe(17);
  });

  it("a model whose second answer is unusable still leaves an honest digest: the snapshot's sentence and the first answer's question", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => (calls.filter(isDigest).length === 1 ? { summary: "You saved 15 items.", worth: [], question: "What would you brew tomorrow?" } : "not json") }) });
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    const d = await digestOf(env, ann.token);
    expect(d).toMatchObject({ summary: "This daily digest covers 16 analyses.", question: "What would you brew tomorrow?" });
  });
});

describe("core#3: another assistant's digest is refused with the reason, and stores nothing", () => {
  it("a summary that states another total is invalid_result naming the right number; the right number, or none, is accepted", async () => {
    const off = makeEnv();
    const { ann, helper } = await withHelper(off);
    const ids: string[] = [];
    for (const batch of [["One thought.", "Two thoughts.", "Three thoughts."]]) ids.push(...(await analysed(off, ann, helper, batch, SKIPPABLE)));
    advance(9 * HOUR_MS);
    await refresh(off, helper);
    const c = await claim(off, helper.access, "digest");
    expect(c.work).toHaveLength(1);
    const day = c.work[0].ref;
    const wrong = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary: "You saved 5 items today.", worth: [], question: "What next?" }]);
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("invalid_result");
    expect(wrong.json.error.message).toContain("3");
    // Nothing was stored: the digest is still due, and the items are not in it.
    expect((await db(off, "SELECT status FROM digests WHERE day = ?", day))[0].status).toBe("due");
    expect((await db(off, "SELECT COUNT(*) AS n FROM items WHERE digest_day IS NOT NULL"))[0].n).toBe(0);
    const right = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary: "You saved 3 items today, all small ones.", worth: [], question: "What next?" }]);
    expect(right.status).toBe(200);
    expect(right.json.outcomes[0].accepted).toBe(true);
    expect((await digestOf(off, ann.token)).counts.saved).toBe(3);
  });

  it("a summary with no number is accepted as before", async () => {
    const off = makeEnv();
    const { ann, helper } = await withHelper(off);
    await analysed(off, ann, helper, ["One thought.", "Two thoughts."], SKIPPABLE);
    advance(9 * HOUR_MS);
    await refresh(off, helper);
    const c = await claim(off, helper.access, "digest");
    const r = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day: c.work[0].ref, summary: "Two small notes on tea.", worth: [], question: "What next?" }]);
    expect(r.json.outcomes[0].accepted).toBe(true);
  });
});

describe("internal-qa #27: a summary that agrees with the digest is not refused for the other quantities in it", () => {
  const FINE = [
    ["en", "You saved 16 items today. Steep the tea for a total of 5 minutes."],
    ["zh", "今天存入了16条。其中共3条讲茶。"],
    ["zh", "今天存入了16条。茶叶合计50克。"],
  ] as const;

  for (const [lang, summary] of FINE) {
    it(`the built-in assistant, ${lang}: one call, and "${summary}" is stored as the model wrote it (no second ask, no fallback sentence)`, async () => {
      const { ann } = await dayOf(16, lang);
      const calls: any[] = [];
      const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => ({ summary, worth: [], question: "What would you brew tomorrow?" }) }) });
      await runMinute(env);
      expect(calls.filter(isDigest)).toHaveLength(1);
      const d = await digestOf(env, ann.token);
      expect(d.summary).toBe(summary);
      expect(d.counts.saved).toBe(16);
      expect(new Set(lines(d)).size).toBe(16);
      const usage = (await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant");
      expect(usage).toMatchObject({ calls: 1 });
    });
  }

  it("another assistant: the same summaries are accepted for the right number of items, and a wrong total next to such a quantity is still refused", async () => {
    const off = makeEnv();
    const { ann, helper } = await withHelper(off);
    await analysed(off, ann, helper, ["One thought.", "Two thoughts.", "Three thoughts."], SKIPPABLE);
    advance(9 * HOUR_MS);
    await refresh(off, helper);
    const c = await claim(off, helper.access, "digest");
    const day = c.work[0].ref;
    const wrong = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary: "You saved 5 items today. Steep the tea for a total of 3 minutes.", worth: [], question: "What next?" }]);
    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("invalid_result");
    expect(wrong.json.error.message).toContain("5");
    expect((await db(off, "SELECT status FROM digests WHERE day = ?", day))[0].status).toBe("due");
    const right = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary: "You saved 3 items today. Steep the tea for a total of 5 minutes.", worth: [], question: "What next?" }]);
    expect(right.status).toBe(200);
    expect(right.json.outcomes[0].accepted).toBe(true);
    expect((await digestOf(off, ann.token)).summary).toBe("You saved 3 items today. Steep the tea for a total of 5 minutes.");
  });
});
