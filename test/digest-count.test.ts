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
async function dayOf(n: number, lang?: string, steps = ["analysis"]) {
  const off = makeEnv();
  const { ann, helper } = await withHelper(off, steps);
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

describe("core#3 (QA's review of 6f28c34): the model is paid for two answers per digest in all, and every answer is on record", () => {
  const spent = async (env: any) => (await db(env, "SELECT calls, input_tokens, output_tokens, items FROM usage_records WHERE kind = 'digest' ORDER BY created_at, id")) as { calls: number; input_tokens: number; output_tokens: number; items: number }[];
  const total = (rows: { calls: number }[]) => rows.reduce((n, r) => n + r.calls, 0);
  const written = async (env: any) => (await db(env, "SELECT status, summary, question FROM digests WHERE status = 'done'")) as { summary: string; question: string }[];

  it("an answer that is not JSON on every Cron run: two answers in all, both on record, and no digest is made up", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => "not json" }) });
    for (let n = 0; n < 4; n++) {
      await runMinute(env);
      advance(60_000);
    }
    expect(calls.filter(isDigest)).toHaveLength(2);
    const rows = await spent(env);
    expect(total(rows)).toBe(2);
    expect(rows.reduce((n, r) => n + r.input_tokens, 0)).toBe(240);
    expect(rows.reduce((n, r) => n + r.output_tokens, 0)).toBe(80);
    expect(rows.every((r) => r.items === 0)).toBe(true);
    // Honest: no digest, so no summary, no question, no list of worth items from nowhere.
    expect(await written(env)).toEqual([]);
    const latest = await call(env, "GET", "/v1/digests/latest", { token: ann.token });
    expect(latest.json.summary ?? null).toBeNull();
    // The usage the user is shown agrees with what was asked.
    const usage = (await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant");
    expect(usage).toMatchObject({ calls: 2 });
  });

  it("an unusable first answer and a good one on the next run: written once, and the two answers are the two on record", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => (calls.filter(isDigest).length === 1 ? "not json" : { summary: "You saved 16 items today.", worth: [], question: "What would you brew tomorrow?" }) }) });
    await runMinute(env);
    expect(await written(env)).toEqual([]);
    advance(60_000);
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    expect(await digestOf(env, ann.token)).toMatchObject({ summary: "You saved 16 items today.", question: "What would you brew tomorrow?" });
    expect(total(await spent(env))).toBe(2);
    // One digest a day: nothing more is asked.
    advance(60_000);
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
  });

  it("an unusable first answer, then a summary with the wrong number: there is no third answer to correct it, so the summary is the snapshot's own sentence", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { digest: () => (calls.filter(isDigest).length === 1 ? "not json" : { summary: "You saved 15 items today.", worth: [], question: "What would you brew tomorrow?" }) }) });
    await runMinute(env);
    advance(60_000);
    await runMinute(env);
    advance(60_000);
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(2);
    expect(await digestOf(env, ann.token)).toMatchObject({ summary: "This daily digest covers 16 analyses.", question: "What would you brew tomorrow?" });
    expect(total(await spent(env))).toBe(2);
  });

  it("a model that is down answers nothing, costs nothing, and does not use up the digest's two answers", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const good = builtinModel(calls, { digest: () => ({ summary: "You saved 16 items today.", worth: [], question: "What would you brew tomorrow?" }) });
    let down = 3;
    const env = makeEnv({
      ...LLM,
      OUTBOUND: async (url, init) => {
        if (String(init?.body).includes("You write the owner's daily digest") && down-- > 0) return new Response("down", { status: 503 });
        return good(url, init);
      },
    });
    for (let n = 0; n < 4; n++) {
      await runMinute(env);
      advance(60_000);
    }
    expect(await digestOf(env, ann.token)).toMatchObject({ summary: "You saved 16 items today." });
    expect(calls.filter(isDigest)).toHaveLength(1);
    expect(total(await spent(env))).toBe(1);
  });

  // QA's review of 3e751d1 / 316e20d: an answer that carries its usage but has no usable text was paid for too.
  const ANOMALIES: [string, () => Response][] = [
    ["an empty answer", () => Response.json({ type: "message", content: [], stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 40 } })],
    ["a refusal", () => Response.json({ type: "message", stop_reason: "refusal", content: [{ type: "text", text: "declined" }], usage: { input_tokens: 120, output_tokens: 40 } })],
  ];
  /** The digest request answered by `odd` for the asks in `which` (1-based), and by the usual stand-in otherwise. */
  const odd = (calls: any[], which: number[], answer: (n: number) => Response, good: Parameters<typeof builtinModel>[1]): { out: Outbound; asked: () => number } => {
    const usual = builtinModel(calls, good);
    let asked = 0;
    return {
      asked: () => asked,
      out: async (url, init) => {
        if (String(init?.body).includes("You write the owner's daily digest")) {
          asked++;
          if (which.includes(asked)) return answer(asked);
        }
        return usual(url, init);
      },
    };
  };

  for (const [what, answer] of ANOMALIES) {
    it(`${what} that carries its usage on every Cron run: two answers in all, both on record at 240/80, and no digest is made up`, async () => {
      const { ann } = await dayOf(16);
      const model = odd([], [1, 2, 3, 4, 5, 6], answer, {});
      const env = makeEnv({ ...LLM, OUTBOUND: model.out });
      for (let n = 0; n < 5; n++) {
        await runMinute(env);
        advance(60_000);
      }
      expect(model.asked()).toBe(2);
      const rows = await spent(env);
      expect(total(rows)).toBe(2);
      expect(rows.reduce((n, r) => n + r.input_tokens, 0)).toBe(240);
      expect(rows.reduce((n, r) => n + r.output_tokens, 0)).toBe(80);
      expect(rows.every((r) => r.items === 0)).toBe(true);
      expect(await written(env)).toEqual([]);
      expect((await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json.summary ?? null).toBeNull();
      expect((await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant")).toMatchObject({ calls: 2 });
    });

    it(`${what} first and a good answer on the next run: written once, and the two answers are the two on record`, async () => {
      const { ann } = await dayOf(16);
      const model = odd([], [1], answer, { digest: () => ({ summary: "You saved 16 items today.", worth: [], question: "What would you brew tomorrow?" }) });
      const env = makeEnv({ ...LLM, OUTBOUND: model.out });
      await runMinute(env);
      expect(await written(env)).toEqual([]);
      expect(total(await spent(env))).toBe(1);
      advance(60_000);
      await runMinute(env);
      expect(await digestOf(env, ann.token)).toMatchObject({ summary: "You saved 16 items today.", question: "What would you brew tomorrow?" });
      expect(model.asked()).toBe(2);
      const rows = await spent(env);
      expect(total(rows)).toBe(2);
      expect(rows.reduce((n, r) => n + r.input_tokens, 0)).toBe(240);
    });

    it(`a summary with the wrong number and then ${what} that carries its usage as the correction: the snapshot's own sentence, the first answer's question, and both answers on record`, async () => {
      const { ann } = await dayOf(16);
      const model = odd([], [2], answer, { digest: () => ({ summary: "You saved 15 items today. This digest covers 15 items.", worth: [], question: "What would you brew tomorrow?" }) });
      const env = makeEnv({ ...LLM, OUTBOUND: model.out });
      await runMinute(env);
      advance(60_000);
      await runMinute(env);
      expect(model.asked()).toBe(2);
      expect(await digestOf(env, ann.token)).toMatchObject({ summary: "This daily digest covers 16 analyses.", question: "What would you brew tomorrow?" });
      const rows = await spent(env);
      expect(total(rows)).toBe(2);
      expect(rows.reduce((n, r) => n + r.input_tokens, 0)).toBe(240);
      expect(rows.reduce((n, r) => n + r.output_tokens, 0)).toBe(80);
      // The usage the user is shown is what was spent.
      expect((await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant")).toMatchObject({ calls: 2 });
    });
  }

  it("an empty answer that says nothing about its usage costs nothing on record: no cost is made up for it", async () => {
    const { ann } = await dayOf(16);
    const model = odd([], [1, 2, 3], () => Response.json({ type: "message", content: [] }), {});
    const env = makeEnv({ ...LLM, OUTBOUND: model.out });
    for (let n = 0; n < 3; n++) {
      await runMinute(env);
      advance(60_000);
    }
    expect(await spent(env)).toEqual([]);
    expect(await written(env)).toEqual([]);
    expect((await call(env, "GET", "/v1/usage", { token: ann.token })).json.assistants.find((u: any) => u.name === "Built-in assistant")?.calls ?? 0).toBe(0);
  });

  it("the next day's digest has a budget of its own", async () => {
    const { ann } = await dayOf(16);
    const calls: any[] = [];
    const bad = builtinModel(calls, { digest: () => "not json" });
    const env = makeEnv({ ...LLM, OUTBOUND: bad });
    for (let n = 0; n < 3; n++) {
      await runMinute(env);
      advance(60_000);
    }
    expect(calls.filter(isDigest)).toHaveLength(2);
    // The next evening: the same items still wait, and the model is asked again, for the new day.
    advance(24 * HOUR_MS);
    await runMinute(env);
    expect(calls.filter(isDigest)).toHaveLength(3);
    expect(ann.token).toBeTruthy();
  });
});

describe("internal-qa #27 (QA's review of a3c855e): another assistant's summary that says what this digest covers", () => {
  it("a wrong number beside a clause about the set is invalid_result and stores nothing; the right number, in the same words, is accepted", async () => {
    const { off, helper } = await dayOf(16, undefined, ["analysis", "digest"]);
    const c = await claim(off, helper.access, "digest");
    const day = c.work[0].ref;
    for (const summary of ["This digest covers 15 items, which span tea and coffee.", "这份每日摘要汇总了15条关于茶的解读。"]) {
      const wrong = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary, worth: [], question: "What next?" }]);
      expect(`${summary} ${wrong.status} ${wrong.json?.error?.code}`).toBe(`${summary} 400 invalid_result`);
    }
    expect(await db(off, "SELECT COUNT(*) AS n FROM digests WHERE status = 'done'")).toEqual([{ n: 0 }]);
    const right = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day, summary: "This digest covers 16 items, which span tea and coffee.", worth: [], question: "What next?" }]);
    expect(right.status).toBe(200);
  });

  for (const summary of ["You saved 16 items today. Steep the tea for a total of 5 minutes.", "今天存入了16条。其中共3条讲茶。", "今天存入了16条。茶叶合计50克。"]) {
    it(`a summary QA found refused although it agrees is accepted: ${summary}`, async () => {
      const { off, helper } = await dayOf(16, undefined, ["analysis", "digest"]);
      const c = await claim(off, helper.access, "digest");
      const r = await submit(off, helper.access, c.claim_id, [{ kind: "digest", day: c.work[0].ref, summary, worth: [], question: "What next?" }]);
      expect(r.status).toBe(200);
    });
  }
});
