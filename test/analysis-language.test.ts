// core#2 / QA #18: a new analysis is written in the language the account has, whatever language the
// item is in, in both directions, and also straight after the language was changed. The model is a
// stand-in that (like the real one) mirrors the item's language unless it is told to translate.
import { describe, expect, it } from "vitest";
import { analysisTarget, digestTarget, scriptOf, writtenIn, wrongLanguageFields } from "../src/builtin";
import { advance, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { builtinModel, call, db, LLM, makeEnv, modelStub, saveText, signIn, signInMine, tool, withHelper, type Outbound } from "./helpers";

const ZH_TEXT = "中文测试笔记：明天上午十点和产品团队开会，讨论新版本的发布计划，请提前准备演示文稿。";
const EN_TEXT = "Cedar team note: the release plan is due on Friday, and the slides need one more pass before the review.";

const english = { summary: "A reminder to prepare slides for tomorrow's meeting.", key_fact: "Text, 38 Chinese characters", points: ["The meeting is at ten."], verdict: "good_to_know" };
const chinese = { summary: "提醒明天上午十点开会前准备好演示文稿。", key_fact: "文本，约 38 个字", points: ["会议在上午十点。"], verdict: "good_to_know" };
const FIXED = { en: english, zh: chinese };

const analysisCalls = (calls: any[]) => calls.filter((c) => c.request.system.startsWith("You analyse"));
const factsOf = (c: any) => JSON.parse(c.request.messages[0].content);

/**
 * A model that mirrors the item's language, as a model does when it is not made to translate:
 * Chinese text gets a Chinese answer and English text an English one, unless the request carries
 * a `correction`. With one it obeys `write_in`.
 */
function mirroring(counts: { first: number; second: number } = { first: 0, second: 0 }) {
  return (input: any) => {
    const mirrored = /[㐀-鿿]/.test(input.content) ? chinese : english;
    if (input.correction) {
      counts.second++;
      return input.write_in === "English" ? english : chinese;
    }
    counts.first++;
    return mirrored;
  };
}

const stored = async (env: any, itemId: string) => (await db(env, "SELECT summary, key_fact, points FROM analyses WHERE item_id = ?", itemId))[0];
const itemIdOf = async (env: any, body: string) => (await db(env, "SELECT id FROM items WHERE body = ?", body))[0].id as string;

describe("core#2: the language of a new analysis is the account's", () => {
  it("the account's language is said in the system prompt and again in the data", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: (i: any) => FIXED[i.write_in === "English" ? "en" : "zh"] }) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    const [c] = analysisCalls(calls);
    expect(c.request.system).toContain("Write in English");
    expect(c.request.system).toMatch(/whatever language the item, its title or the owner's rules are written in/);
    expect(factsOf(c).write_in).toBe("English");
    expect(factsOf(c).correction).toBeUndefined();

    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } });
    await saveText(env, ann.token, EN_TEXT);
    await runMinute(env);
    const zh = analysisCalls(calls).at(-1);
    expect(zh.request.system).toContain("Write in 简体中文");
    expect(zh.request.system).not.toContain("English");
    expect(factsOf(zh).write_in).toBe("简体中文");
  });

  it("Chinese text under an English account: a Chinese answer is asked for again, and the English one is kept", async () => {
    const calls: any[] = [];
    const counts = { first: 0, second: 0 };
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: mirroring(counts) }) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(counts).toEqual({ first: 1, second: 1 });
    const [first, second] = analysisCalls(calls);
    expect(factsOf(first).correction).toBeUndefined();
    expect(factsOf(second).correction).toBe("Your previous answer was not in English. Write every text field in English, translating from the item.");
    const row = await stored(env, await itemIdOf(env, ZH_TEXT));
    expect(row).toMatchObject({ summary: english.summary, key_fact: english.key_fact });
    expect(writtenIn("en", `${row.summary} ${row.key_fact} ${row.points}`)).toBe(true);
    // Both answers are paid for: two calls' tokens (120 in, 40 out each in the stand-in).
    expect((await db(env, "SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage_records WHERE kind = 'analysis'"))[0]).toEqual({ i: 240, o: 80 });
  });

  it("English text under a Chinese account: an English answer is asked for again, and the Chinese one is kept", async () => {
    const counts = { first: 0, second: 0 };
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel([], { analysis: mirroring(counts) }) });
    const ann = await signInMine(env);
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } });
    await saveText(env, ann.token, EN_TEXT);
    await runMinute(env);
    expect(counts).toEqual({ first: 1, second: 1 });
    const row = await stored(env, await itemIdOf(env, EN_TEXT));
    expect(row.summary).toBe(chinese.summary);
    expect(writtenIn("zh", `${row.summary} ${row.key_fact} ${row.points}`)).toBe(true);
  });

  it("right after a change: Chinese text under an account just switched to English, and English text under one just switched to Chinese", async () => {
    const counts = { first: 0, second: 0 };
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel([], { analysis: mirroring(counts) }) });
    const ann = await signInMine(env);
    // Set to Chinese, English text (the model mirrors, is corrected, and ends in Chinese) ...
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } })).json.lang).toBe("zh");
    await saveText(env, ann.token, EN_TEXT);
    await runMinute(env);
    const one = await stored(env, await itemIdOf(env, EN_TEXT));
    expect(writtenIn("zh", one.summary)).toBe(true);
    // ... and straight back to English, with Chinese text: the persisted value is what is asked for.
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "en" } })).json.lang).toBe("en");
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    const two = await stored(env, await itemIdOf(env, ZH_TEXT));
    expect(writtenIn("en", two.summary)).toBe(true);
    expect(two.summary).toBe(english.summary);
    // What was written earlier is untouched by the change.
    expect((await stored(env, await itemIdOf(env, EN_TEXT))).summary).toBe(chinese.summary);
    expect((await db(env, "SELECT COUNT(*) AS n FROM analyses"))[0].n).toBe(2);
  });

  it("an answer in the right language the first time is the only call", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: () => english }) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(1);
  });

  it("a model that never writes in the language is asked twice, and the item is analysed all the same", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: () => chinese }) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(2);
    const [row] = await db(env, "SELECT unavailable, summary FROM analyses");
    expect(row).toMatchObject({ unavailable: 0, summary: chinese.summary });
    expect((await call(env, "GET", `/v1/items/${(await db(env, "SELECT id FROM items"))[0].id}`, { token: ann.token })).json.stage).toBe("analysed");
  });

  it("an answer with no key point and in the wrong language is corrected on both counts in one more call", async () => {
    const calls: any[] = [];
    const env = makeEnv({
      ...LLM,
      OUTBOUND: builtinModel(calls, { analysis: (i: any) => (i.correction ? english : { ...chinese, points: [] }) }),
    });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(2);
    const note = factsOf(analysisCalls(calls)[1]).correction as string;
    expect(note).toContain("not in English");
    expect(note).toContain("no key point");
    expect(await stored(env, await itemIdOf(env, ZH_TEXT))).toMatchObject({ summary: english.summary, points: JSON.stringify(english.points) });
  });

  it("an image the model looks at is told the language too, and the correction goes into the same text block", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: (i: any) => (i.correction ? english : chinese) }) });
    const ann = await signInMine(env);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", png))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const up = await call(env, "POST", "/v1/assets", { token: ann.token, body: { sha256: sha, bytes: png.byteLength, content_type: "image/png" } });
    await call(env, "PUT", up.json.upload_url, { raw: png, headers: { "content-type": "image/png" } });
    await call(env, "POST", `/v1/assets/${up.json.asset_id}/complete`, { token: ann.token });
    await call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "image", asset_id: up.json.asset_id, title: "截图" }, idem: "image-language-1" });
    await runMinute(env);
    const asked = analysisCalls(calls);
    expect(asked).toHaveLength(2);
    for (const c of asked) {
      const blocks = c.request.messages[0].content;
      expect(blocks[0].type).toBe("image");
      expect(JSON.parse(blocks[1].text).write_in).toBe("English");
    }
    expect(JSON.parse(asked[1].request.messages[0].content[1].text).correction).toContain("not in English");
  });
});

describe("core#2: telling the language by its script", () => {
  it("mostly Chinese characters is Chinese; mostly Latin letters is English; a few words of the other do not tip it", () => {
    expect(writtenIn("zh", "提醒明天上午十点开会前准备好演示文稿。")).toBe(true);
    expect(writtenIn("en", "提醒明天上午十点开会前准备好演示文稿。")).toBe(false);
    expect(writtenIn("en", "A reminder to prepare the slides.")).toBe(true);
    expect(writtenIn("zh", "A reminder to prepare the slides.")).toBe(false);
    expect(writtenIn("en", "A note about the 季度总结 due on Friday, with the Q3 numbers in it.")).toBe(true);
    expect(writtenIn("zh", "提醒：周五前把 Q3 report 交给产品团队，并且准备好演示文稿。")).toBe(true);
  });

  it("text with no letters cannot be judged and passes", () => {
    expect(writtenIn("en", "")).toBe(true);
    expect(writtenIn("zh", "12 / 34 — 5.6%")).toBe(true);
  });
});

// ---------------------------------------------------------------- the review of core#5 (QA #18, 2026-11-26)

type Step = {
  json?: unknown;
  text?: string;
  status?: number;
  hang?: boolean;
  delay?: number;
  usage?: [number, number];
  /** An HTTP 200 whose stop_reason is "refusal", or whose content is empty: no text to use, but it may still report usage. */
  refusal?: boolean;
  empty?: boolean;
  /** Leave the usage object out of the reply altogether. */
  noUsage?: boolean;
};
type Asked = { effort: boolean; correction: string | undefined };

/**
 * A model whose analysis answers are scripted one after the other (the last one repeats), each with its
 * own token counts, so that what is paid for can be told apart. Triage and digest are answered plainly.
 */
function scripted(steps: Step[], asked: Asked[] = []): Outbound {
  let n = 0;
  return async (url, init) => {
    if (!url.endsWith("/v1/messages")) return new Response("not stubbed: " + url, { status: 599 });
    const request = JSON.parse(String(init?.body));
    const content = request.messages[0].content;
    const input = JSON.parse(typeof content === "string" ? content : content.find((b: any) => b.type === "text").text);
    const reply = (value: unknown, usage: [number, number] = [120, 40]) =>
      Response.json({ id: "m", type: "message", role: "assistant", model: request.model, stop_reason: "end_turn", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], usage: { input_tokens: usage[0], output_tokens: usage[1] } });
    if (request.system.startsWith("You sort")) return reply(input.items.map((i: any) => ({ item_id: i.item_id })));
    if (!request.system.startsWith("You analyse")) return reply({ summary: "A day.", worth: [], question: "What next?" });
    asked.push({ effort: Boolean(request.output_config), correction: input.correction });
    const step = steps[Math.min(n++, steps.length - 1)];
    if (step.delay) await new Promise((r) => setTimeout(r, step.delay));
    if (step.hang) return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    if (step.status) return new Response("no", { status: step.status });
    if (step.refusal || step.empty) {
      const [i, o] = step.usage ?? [120, 40];
      return Response.json({
        id: "m",
        type: "message",
        role: "assistant",
        model: request.model,
        stop_reason: step.refusal ? "refusal" : "end_turn",
        content: step.refusal ? [{ type: "text", text: "I cannot comply." }] : [],
        ...(step.noUsage ? {} : { usage: { input_tokens: i, output_tokens: o } }),
      });
    }
    return reply(step.text ?? step.json, step.usage);
  };
}

const paid = async (env: any) => (await db(env, "SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(calls),0) AS calls, COALESCE(SUM(items),0) AS items FROM usage_records WHERE kind = 'analysis'"))[0];
const analysed = async (env: any) => (await db(env, "SELECT summary, unavailable FROM analyses"))[0];

describe("core#5 review: every field is judged on its own", () => {
  const longEnglish = "The team will complete the release checklist and review the remaining accessibility work before Friday.";

  it("a long answer in the right language in one field does not hide a field in the wrong one (English account)", () => {
    const mixed = { summary: longEnglish, key_fact: "Text, 38 Chinese characters", points: ["请在星期五前提交修改。"], verdict: "good_to_know" };
    expect(wrongLanguageFields("en", mixed)).toEqual(["points[0]"]);
    expect(wrongLanguageFields("en", { ...mixed, points: ["Fine."], related_hint: "与上周的发布清单有关" })).toEqual(["related_hint"]);
    expect(wrongLanguageFields("en", { ...mixed, points: [longEnglish, "请在星期五前提交修改。"] })).toEqual(["points[1]"]);
  });

  it("and the other way round (Chinese account), and prose that is entirely kana or Hangul is neither", () => {
    const zhLong = "团队会在周五之前完成发布清单，并且检查剩下的无障碍改进工作。";
    expect(wrongLanguageFields("zh", { summary: zhLong, key_fact: "文本，约 38 个字", points: ["Please send the changes before Friday."] })).toEqual(["points[0]"]);
    expect(wrongLanguageFields("en", { summary: longEnglish, points: ["これは金曜日までに提出する修正についてのメモです。"] })).toEqual(["points[0]"]);
    expect(wrongLanguageFields("zh", { summary: zhLong, points: ["これは金曜日までに提出する修正についてのメモです。"] })).toEqual(["points[0]"]);
    expect(wrongLanguageFields("en", { summary: longEnglish, points: ["이것은 금요일까지 제출할 수정 사항에 대한 메모입니다."] })).toEqual(["points[0]"]);
    expect(wrongLanguageFields("zh", { summary: zhLong, points: ["Это заметка об изменениях, которые нужно сдать до пятницы."] })).toEqual(["points[0]"]);
  });

  it("numbers, names, acronyms, addresses and quoted titles are allowed in any field", () => {
    expect(wrongLanguageFields("en", { summary: `${longEnglish} Ask 张伟 about it.`, key_fact: "38", points: ["See https://example.org/发布清单 for the list.", "The note is titled “发布清单检查表”.", "PDF"], related_hint: "Connects to “本周的发布计划”." })).toEqual([]);
    expect(wrongLanguageFields("zh", { summary: "团队会在周五之前完成发布清单，并且检查剩下的工作。", key_fact: "PDF，3 页", points: ["详见 https://example.org/checklist，标题是 “Release checklist”。", "联系 Anna，邮箱 anna@example.org。"] })).toEqual([]);
    expect(wrongLanguageFields("en", {})).toEqual([]);
  });

  it("a wrong field in a long answer is corrected by the second call, and the corrected answer is stored", async () => {
    const mixed = { summary: longEnglish, key_fact: "Text, 38 Chinese characters", points: ["请在星期五前提交修改。"], verdict: "good_to_know" };
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: mixed, usage: [100, 30] }, { json: english, usage: [130, 35] }], asked) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(asked).toHaveLength(2);
    expect(asked[1].correction).toContain("not in English");
    expect((await stored(env, await itemIdOf(env, ZH_TEXT))).points).toBe(JSON.stringify(english.points));
    expect(await paid(env)).toEqual({ i: 230, o: 65, calls: 2, items: 1 });
  });

  it("a mixed answer that only quotes a name or a title is one call", async () => {
    const quoting = { summary: longEnglish, key_fact: "Text, 38 Chinese characters", points: ["Ask 张伟 about the “发布清单”."], verdict: "good_to_know" };
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: quoting }], asked) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(asked).toHaveLength(1);
    expect(await paid(env)).toMatchObject({ calls: 1, items: 1 });
  });
});

describe("core#5 review: every reply that came back is counted", () => {
  const wrong = { ...chinese };

  const seconds: [string, Step][] = [
    ["is prose, not JSON", { text: "Sorry, here is the analysis in prose." }],
    ["says unavailable", { json: { unavailable: true } }],
    ["is a JSON array", { json: [] }],
    ["has no verdict or points", { json: { summary: "No verdict or points." } }],
  ];
  for (const [name, second] of seconds) {
    it(`a second reply that ${name} is paid for, and the first answer stands`, async () => {
      const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: wrong, usage: [100, 30] }, { ...second, usage: [140, 25] }]) });
      const ann = await signInMine(env);
      await saveText(env, ann.token, ZH_TEXT);
      await runMinute(env);
      expect((await analysed(env)).summary).toBe(chinese.summary);
      expect(await paid(env)).toEqual({ i: 240, o: 55, calls: 2, items: 1 });
    });
  }

  it("a first reply that is not JSON is paid for too, though nothing is handed in; the item is tried again", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ text: "not json at all", usage: [111, 22] }]) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(await db(env, "SELECT COUNT(*) AS n FROM analyses")).toEqual([{ n: 0 }]);
    expect(await paid(env)).toEqual({ i: 111, o: 22, calls: 1, items: 0 });
    // The claim went back: the next round asks again and pays again.
    await runMinute(env);
    expect(await paid(env)).toMatchObject({ i: 222, o: 44, calls: 2 });
  });

  it("two items in one round: what each cost is added up, the discarded second answer of one included", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: english, usage: [100, 10] }, { json: english, usage: [100, 10] }]) });
    const ann = await signInMine(env);
    await saveText(env, ann.token, EN_TEXT);
    await saveText(env, ann.token, EN_TEXT + " Second.");
    await runMinute(env);
    expect(await paid(env)).toEqual({ i: 200, o: 20, calls: 2, items: 2 });
  });
});

describe("core#5 review: a correction that fixes one flaw and loses another", () => {
  const noPointsEnglish = { ...english, points: [] };
  const noPointsChinese = { ...chinese, points: [] };

  it("equal numbers of flaws keep the first answer: right language without a key point, then a key point in the wrong language", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: noPointsEnglish }, { json: chinese }]) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await stored(env, await itemIdOf(env, ZH_TEXT))).points).toBe("[]");
    expect((await analysed(env)).summary).toBe(english.summary);
    expect(await paid(env)).toMatchObject({ calls: 2 });
  });

  it("equal numbers of flaws keep the first answer: a key point in the wrong language, then the right language without one", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: chinese }, { json: noPointsEnglish }]) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await analysed(env)).summary).toBe(chinese.summary);
    expect((await stored(env, await itemIdOf(env, ZH_TEXT))).points).toBe(JSON.stringify(chinese.points));
    expect(await paid(env)).toMatchObject({ calls: 2 });
  });

  it("a correction that has fewer flaws replaces the first answer, even when it still has one", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: noPointsChinese }, { json: noPointsEnglish }]) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await analysed(env)).summary).toBe(english.summary);
  });
});

describe("core#5 review: one bounded budget for everything asked about an item", () => {
  it("a gateway that refuses the effort field costs one extra request once, not one per call: three requests at most", async () => {
    const asked: Asked[] = [];
    const base = scripted([{ json: chinese }], asked);
    let requests = 0;
    // The gateway answers 400 to any request that carries `output_config`, as one that does not know the field.
    const picky: Outbound = async (url, init) => {
      const body = String(init?.body ?? "");
      if (url.endsWith("/v1/messages") && body.includes("output_config") && JSON.parse(body).system.startsWith("You analyse")) {
        requests++;
        return new Response("unknown field", { status: 400 });
      }
      if (url.endsWith("/v1/messages") && JSON.parse(body).system.startsWith("You analyse")) requests++;
      return base(url, init);
    };
    const env = makeEnv({ ...LLM, OUTBOUND: picky });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    // First call: 400 with the field, then fine without it; the correction is sent without it at once. Never four.
    expect(requests).toBe(3);
    expect(asked.map((a) => a.effort)).toEqual([false, false]);
    expect(await paid(env)).toMatchObject({ calls: 2 });
    expect((await analysed(env)).unavailable).toBe(0);
  });

  it("a correction that does not answer is given up on at the end of the one budget, not after a fresh 25 seconds", async () => {
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, ANALYSIS_BUDGET_MS: "700", OUTBOUND: scripted([{ json: chinese, usage: [100, 30] }, { hang: true }], asked) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    const started = Date.now();
    await runMinute(env);
    const took = Date.now() - started;
    expect(asked).toHaveLength(2);
    expect(took).toBeLessThan(4000);
    // The first answer stands (an honest result), and only the reply that came back was paid for.
    expect((await analysed(env)).summary).toBe(chinese.summary);
    expect(await paid(env)).toEqual({ i: 100, o: 30, calls: 1, items: 1 });
  });

  it("with too little of the budget left after the first answer, the correction is not asked for at all", async () => {
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, ANALYSIS_BUDGET_MS: "600", OUTBOUND: scripted([{ json: chinese, delay: 450 }], asked) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect(asked).toHaveLength(1);
    expect((await analysed(env)).summary).toBe(chinese.summary);
    expect(await paid(env)).toMatchObject({ calls: 1, items: 1 });
  });

  it("the budget is per item: the first answer's own limit still holds, and a model that never answers leaves the item for later", async () => {
    const env = makeEnv({ ...LLM, ANALYSIS_BUDGET_MS: "300", OUTBOUND: scripted([{ hang: true }]) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    const started = Date.now();
    await runMinute(env);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await db(env, "SELECT COUNT(*) AS n FROM analyses")).toEqual([{ n: 0 }]);
    expect(await paid(env)).toMatchObject({ calls: 0 });
  });
});

describe("core#5 review, round two: a correction that cannot be used does not push out a usable first answer", () => {
  // QA's case: an English account, an item whose first answer is a complete analysis in Chinese.
  const firstUsable = { summary: "这是一条用于检查发布清单的测试笔记。", key_fact: "文本共有三十八个字。", points: ["请在星期五前提交修改。"], verdict: "good_to_know" };
  const asked = (steps: Step[]) => {
    const calls: Asked[] = [];
    return { calls, env: makeEnv({ ...LLM, OUTBOUND: scripted(steps, calls) }) };
  };

  for (const [what, broken] of [
    ["no verdict", { summary: "A reminder to prepare the release checklist.", key_fact: "Text, 38 characters", points: ["Send the changes before Friday."] }],
    ["a verdict that is not one of the three", { summary: "A reminder to prepare the release checklist.", key_fact: "Text, 38 characters", points: ["Send the changes before Friday."], verdict: "maybe" }],
    ["no summary", { key_fact: "Text, 38 characters", points: ["Send the changes before Friday."], verdict: "good_to_know" }],
    ["a blank summary", { summary: "   ", key_fact: "Text, 38 characters", points: ["Send the changes before Friday."], verdict: "good_to_know" }],
  ] as const) {
    it(`${what}, in the right language and with key points: the first answer stands, both replies are counted, and there is no third request`, async () => {
      const { env, calls } = asked([{ json: firstUsable, usage: [100, 10] }, { json: broken, usage: [90, 9] }]);
      await saveText(env, (await signInMine(env)).token, ZH_TEXT);
      await runMinute(env);
      expect(calls).toHaveLength(2);
      expect((await analysed(env)).summary).toBe(firstUsable.summary);
      expect(await paid(env)).toEqual({ i: 190, o: 19, calls: 2, items: 1 });
    });
  }

  it("a correction that is whole does replace a first answer that was whole too, when it has fewer flaws", async () => {
    const whole = { summary: "A reminder to prepare the release checklist.", key_fact: "Text, 38 characters", points: ["Send the changes before Friday."], verdict: "good_to_know" };
    const { env } = asked([{ json: firstUsable }, { json: whole }]);
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await analysed(env)).summary).toBe(whole.summary);
  });

  it("a whole correction does replace a first answer that could not be used at all (no verdict), instead of failing the item", async () => {
    const noVerdictChinese = { summary: "这是一条用于检查发布清单的测试笔记。", key_fact: "文本共有三十八个字。", points: ["请在星期五前提交修改。"] };
    const whole = { summary: "A reminder to prepare the release checklist.", key_fact: "Text, 38 characters", points: ["Send the changes before Friday."], verdict: "good_to_know" };
    const { env } = asked([{ json: noVerdictChinese, usage: [100, 10] }, { json: whole, usage: [90, 9] }]);
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await analysed(env)).summary).toBe(whole.summary);
    expect(await paid(env)).toEqual({ i: 190, o: 19, calls: 2, items: 1 });
  });
});

describe("core#5 review, round two: what the provider reports is counted whether or not there was text to use", () => {
  const firstUsable = { summary: "这是一条用于检查发布清单的测试笔记。", key_fact: "文本共有三十八个字。", points: ["请在星期五前提交修改。"], verdict: "good_to_know" };
  const usage: [number, number] = [140, 25];

  for (const kind of ["refusal", "empty"] as const) {
    it(`a first reply that is a ${kind} but reports usage is paid for, and the item is tried again`, async () => {
      const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ [kind]: true, usage }]) });
      await saveText(env, (await signInMine(env)).token, ZH_TEXT);
      await runMinute(env);
      expect(await db(env, "SELECT COUNT(*) AS n FROM analyses")).toEqual([{ n: 0 }]);
      expect(await paid(env)).toEqual({ i: 140, o: 25, calls: 1, items: 0 });
      // The claim went back: the next round asks again and pays again.
      await runMinute(env);
      expect(await paid(env)).toMatchObject({ i: 280, o: 50, calls: 2 });
    });

    it(`a correction that is a ${kind} but reports usage is paid for, and the first answer stands`, async () => {
      const calls: Asked[] = [];
      const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: firstUsable, usage: [100, 10] }, { [kind]: true, usage }], calls) });
      await saveText(env, (await signInMine(env)).token, ZH_TEXT);
      await runMinute(env);
      expect(calls).toHaveLength(2);
      expect((await analysed(env)).summary).toBe(firstUsable.summary);
      expect(await paid(env)).toEqual({ i: 240, o: 35, calls: 2, items: 1 });
    });

    it(`a ${kind} that reports no usage is not made up: nothing is counted for it`, async () => {
      const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ [kind]: true, noUsage: true }]) });
      await saveText(env, (await signInMine(env)).token, ZH_TEXT);
      await runMinute(env);
      expect(await paid(env)).toEqual({ i: 0, o: 0, calls: 0, items: 0 });
    });
  }

  it("a correction that is a refusal without usage costs nothing more: only the first reply is counted", async () => {
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: firstUsable, usage: [100, 10] }, { refusal: true, noUsage: true }]) });
    await saveText(env, (await signInMine(env)).token, ZH_TEXT);
    await runMinute(env);
    expect((await analysed(env)).summary).toBe(firstUsable.summary);
    expect(await paid(env)).toEqual({ i: 100, o: 10, calls: 1, items: 1 });
  });
});

// ---------------------------------------------------------------- P5: Cheney's option 2 (internal-qa #18, 2026-11-26)
// By default an analysis and a daily digest follow the language of the item itself; the account switch
// "always use my language" makes them use the account's. Everything above this line is about that switch being on.

const FRENCH = "Le comité publiera le plan de la version vendredi prochain, et les diapositives doivent encore être relues.";
const WITH_NAME = "Meeting with 张伟 tomorrow about the release plan and the slides we still have to finish.";
const KANA = "これはにほんごのめもですきょうはしごとがおわりました";
const HANGUL = "오늘은 회의가 있습니다 발표 자료를 준비하세요";
const CYRILLIC = "Завтра в десять часов встреча команды по выпуску новой версии";
const ZH_TEXT_2 = "第二条中文笔记：周五之前要把发布清单和无障碍检查的结果整理好，发给团队。";
const EN_TEXT_2 = "Second English note: the accessibility review results go to the team before Friday noon.";
const byItem = (input: any) => (/[㐀-鿿]/.test(input.content) ? chinese : english);
const obeying = (input: any) => (input.write_in === "简体中文" ? chinese : english);

describe("P5: the script of a text, and what is to be written in", () => {
  it("tells Chinese and Latin script apart, and says nothing when there is too little text or it is another script", () => {
    expect(scriptOf(ZH_TEXT)).toBe("zh");
    expect(scriptOf(EN_TEXT)).toBe("latin");
    expect(scriptOf(FRENCH)).toBe("latin");
    // Quoted words, names and addresses are not what a text is written in.
    expect(scriptOf("这是一篇关于《Release Checklist》的笔记，明天要看，https://example.org/release-checklist")).toBe("zh");
    expect(scriptOf(WITH_NAME)).toBe("latin");
    for (const cannot of ["", "   ", "好的", "PDF 3 页", "OK", "12345 67890", KANA, HANGUL, CYRILLIC]) expect(`${JSON.stringify(cannot)} ${scriptOf(cannot)}`).toBe(`${JSON.stringify(cannot)} null`);
    // The same thresholds as the check of an answer: what is "zh" passes writtenIn("zh"), what is "latin" passes writtenIn("en").
    for (const [text, script] of [[ZH_TEXT, "zh"], [EN_TEXT, "latin"], [FRENCH, "latin"]] as const) expect(writtenIn(script === "zh" ? "zh" : "en", text)).toBe(true);
  });

  it("an analysis follows the item, unless the switch is on or the item's language cannot be told", () => {
    expect(analysisTarget("en", false, ZH_TEXT)).toEqual({ name: "简体中文", check: "zh", from: "item" });
    expect(analysisTarget("zh", false, EN_TEXT)).toEqual({ name: "the language the item's own text is written in", check: "en", from: "item" });
    expect(analysisTarget("zh", false, FRENCH).from).toBe("item");
    // The switch: always the account's.
    expect(analysisTarget("en", true, ZH_TEXT)).toEqual({ name: "English", check: "en", from: "account" });
    expect(analysisTarget("zh", true, EN_TEXT)).toEqual({ name: "简体中文", check: "zh", from: "account" });
    // Cannot be told: the account's.
    for (const cannot of ["", "好的", KANA, HANGUL, CYRILLIC]) {
      expect(analysisTarget("en", false, cannot)).toEqual({ name: "English", check: "en", from: "account" });
      expect(analysisTarget("zh", false, cannot)).toEqual({ name: "简体中文", check: "zh", from: "account" });
    }
  });

  it("a digest follows the language most of the day's analyses are in; an even split, none to go by, or the switch: the account's", () => {
    expect(digestTarget("en", false, [chinese.summary, chinese.summary, english.summary])).toMatchObject({ name: "简体中文", from: "item" });
    expect(digestTarget("zh", false, [english.summary, english.summary, chinese.summary])).toMatchObject({ check: "en", from: "item" });
    expect(digestTarget("en", false, [chinese.summary, english.summary])).toMatchObject({ name: "English", from: "account" });
    expect(digestTarget("zh", false, [])).toMatchObject({ name: "简体中文", from: "account" });
    expect(digestTarget("zh", false, ["好的", "OK"])).toMatchObject({ from: "account" });
    expect(digestTarget("en", true, [chinese.summary, chinese.summary])).toMatchObject({ name: "English", from: "account" });
  });
});

describe("P5: a new analysis follows the item by default", () => {
  it("a Chinese item under an English account is analysed in Chinese, once, and is not translated", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: byItem }) });
    const ann = await signIn(env); // an English account, the switch off
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(1);
    const [c] = analysisCalls(calls);
    expect(c.request.system).toContain("Write in 简体中文");
    expect(c.request.system).toContain("do not translate it into another language");
    expect(c.request.system).not.toContain("translate what you report");
    expect(factsOf(c).write_in).toBe("简体中文");
    expect((await analysed(env)).summary).toBe(chinese.summary);
  });

  it("an English item under a Chinese account is analysed in the item's own language, once", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: byItem }) });
    const ann = await signIn(env, "ann@example.com", "zh");
    await saveText(env, ann.token, EN_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(1);
    const [c] = analysisCalls(calls);
    expect(c.request.system).toContain("Write in the language the item's own text is written in");
    expect(c.request.system).not.toContain("Write in 简体中文");
    expect(c.request.system).toContain("do not translate it into another language");
    expect(factsOf(c).write_in).toBe("the language the item's own text is written in");
    expect((await analysed(env)).summary).toBe(english.summary);
  });

  it("a French item is not forced into English or Chinese: the model is told to keep its language, and an answer in Chinese is asked for again", async () => {
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: chinese }, { json: english }], asked) });
    await saveText(env, (await signIn(env, "ann@example.com", "zh")).token, FRENCH);
    await runMinute(env);
    expect(asked).toHaveLength(2);
    expect(asked[1].correction).toMatch(/was not in the language the item's own text is written in/);
    expect(asked[1].correction).toMatch(/do not translate it into another language/);
    expect(asked[1].correction).not.toMatch(/translating from the item/);
  });

  it("the switch decides the next analysis only: turning it on does not rewrite or translate what exists", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: obeying }) });
    const ann = await signIn(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)[0].request.system).toContain("Write in 简体中文");
    const patched = await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: true } });
    expect(patched.json.always_my_language).toBe(true);
    await saveText(env, ann.token, ZH_TEXT_2);
    await runMinute(env);
    const second = analysisCalls(calls).at(-1);
    expect(second.request.system).toContain("Write in English");
    expect(second.request.system).toContain("translate what you report");
    expect(analysisCalls(calls)).toHaveLength(2);
    // Turning it off again goes back to the item.
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: false } });
    await saveText(env, ann.token, "第三条中文笔记：下周一的评审会改到下午三点，会议室不变，请大家准时参加并带好材料。");
    await runMinute(env);
    expect(analysisCalls(calls).at(-1).request.system).toContain("Write in 简体中文");
    // The first analysis still reads as it was written.
    expect((await db(env, "SELECT summary FROM analyses ORDER BY created_at ASC LIMIT 1"))[0].summary).toBe(chinese.summary);
  });

  it("an item whose language cannot be told gets the account's: a few characters, a name, kana, Hangul, Cyrillic", async () => {
    // One database serves the whole test: each case is its own account (an existing account keeps its language).
    let n = 0;
    for (const [text, account, expected] of [
      ["好的", "en", "Write in English"],
      ["张伟", "en", "Write in English"],
      [KANA, "zh", "Write in 简体中文"],
      [HANGUL, "en", "Write in English"],
      [CYRILLIC, "zh", "Write in 简体中文"],
    ] as const) {
      const calls: any[] = [];
      const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: obeying }) });
      await saveText(env, (await signIn(env, `case${++n}@example.com`, account)).token, text);
      await runMinute(env);
      expect(`${text} ${analysisCalls(calls)[0].request.system.includes(expected)}`).toBe(`${text} true`);
      expect(factsOf(analysisCalls(calls)[0]).write_in).toBe(account === "zh" ? "简体中文" : "English");
    }
  });

  it("a Chinese item answered in English is asked for again in the item's language, and the Chinese answer is kept", async () => {
    const asked: Asked[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: scripted([{ json: english, usage: [100, 10] }, { json: chinese, usage: [90, 9] }], asked) });
    await saveText(env, (await signIn(env)).token, ZH_TEXT);
    await runMinute(env);
    expect(asked).toHaveLength(2);
    expect(asked[1].correction).toMatch(/was not in 简体中文/);
    expect(asked[1].correction).toMatch(/do not translate it into another language/);
    expect((await analysed(env)).summary).toBe(chinese.summary);
    expect(await paid(env)).toEqual({ i: 190, o: 19, calls: 2, items: 1 });
  });
});

describe("P5: the daily digest follows the day's analyses by default", () => {
  /** Saves the texts, lets them be analysed (each in its own language), and writes the digest at 21:05; returns the digest's system prompt. */
  async function digestSystem(texts: string[], opts: { account?: "en" | "zh"; mine?: boolean } = {}) {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, TRIAGE_BATCH: "10", ANALYSIS_BATCH: "10", OUTBOUND: builtinModel(calls, { analysis: byItem }) });
    const ann = await (opts.mine ? signInMine : signIn)(env, "ann@example.com", opts.account ?? "en");
    for (const t of texts) await saveText(env, ann.token, t);
    await runMinute(env);
    expect((await db(env, "SELECT COUNT(*) AS n FROM analyses"))[0].n).toBe(texts.length);
    advance(9 * 60 * MINUTE + 5 * MINUTE); // 21:05 in the account's time zone
    await runMinute(env);
    const digest = calls.find((c) => c.request.system.startsWith("You write"));
    expect(digest, "a digest was asked for").toBeTruthy();
    return digest.request.system as string;
  }

  it("most of the day's analyses in Chinese: written in Chinese, under an English account", async () => {
    const system = await digestSystem([ZH_TEXT, ZH_TEXT_2, EN_TEXT]);
    expect(system).toContain("Write in 简体中文 (most of the analyses are in it)");
    expect(system).toContain("do not translate it into another language");
  });

  it("most in English: written in the analyses' own language, under a Chinese account", async () => {
    const system = await digestSystem([EN_TEXT, EN_TEXT_2, ZH_TEXT], { account: "zh" });
    expect(system).toContain("Write in the language the item's own text is written in (most of the analyses are in it)");
    expect(system).not.toContain("Write in 简体中文");
  });

  it("an even split goes to the account's language, with translation", async () => {
    const system = await digestSystem([ZH_TEXT, EN_TEXT]);
    expect(system).toContain("Write in English, whatever language the analyses are in: translate what you report");
  });

  it("with the switch on it is the account's language, whatever the day's analyses are in", async () => {
    const system = await digestSystem([ZH_TEXT, ZH_TEXT_2], { mine: true });
    expect(system).toContain("Write in English, whatever language the analyses are in: translate what you report");
  });
});

describe("P5 review: the sentence the core writes when a digest's number will not agree is in the digest's language too", () => {
  /**
   * Saves the texts, lets them be analysed (each in its own language), and writes the digest at 21:05 with a model that
   * states the wrong number every time (in the language it was told to write in), so that the second ask fails and the
   * core writes the sentence itself. Returns what was stored and how often the model was asked.
   */
  async function fallbackDigest(texts: string[], opts: { account: "en" | "zh"; mine?: boolean; analysis?: (input: any) => unknown; secondAskUnusable?: boolean }) {
    const calls: any[] = [];
    const model = modelStub((req) => {
      const content = req.messages[0].content;
      const input = JSON.parse(typeof content === "string" ? content : content.find((b: any) => b.type === "text").text);
      if (req.system.startsWith("You sort")) return input.items.map((i: any) => ({ item_id: i.item_id }));
      if (req.system.startsWith("You analyse")) return (opts.analysis ?? byItem)(input);
      // The second ask gets no usable answer (not JSON): the core's sentence is written then too, not only when the number is wrong twice.
      if (opts.secondAskUnusable && calls.filter((c) => c.request.system.startsWith("You write")).length === 2) return "not json";
      // The digest: one more than the snapshot has, in the language the system prompt asks for (Chinese when it says 简体中文).
      const zh = req.system.includes("Write in 简体中文");
      return { summary: zh ? `今天存入了${input.total + 1}条。` : `You saved ${input.total + 1} items today.`, worth: [], question: zh ? "明天做什么？" : "What next?" };
    }, calls);
    const env = makeEnv({ ...LLM, TRIAGE_BATCH: "10", ANALYSIS_BATCH: "10", OUTBOUND: model });
    const ann = await (opts.mine ? signInMine : signIn)(env, "ann@example.com", opts.account);
    for (const t of texts) await saveText(env, ann.token, t);
    await runMinute(env);
    expect((await db(env, "SELECT COUNT(*) AS n FROM analyses"))[0].n).toBe(texts.length);
    advance(9 * 60 * MINUTE + 5 * MINUTE); // 21:05 in the account's time zone
    await runMinute(env);
    const asked = calls.filter((c) => c.request.system.startsWith("You write"));
    const digest = (await call(env, "GET", "/v1/digests/latest", { token: ann.token })).json;
    return { asked, digest };
  }

  // Each case is its own test: one database and one clock serve a whole test, and a digest is written once a day.
  // What the day's analyses say decides the language, not what was saved: these summaries are too short to tell, or kana / Hangul (neither English nor Chinese).
  const TOO_SHORT = () => ({ summary: "好的", key_fact: "好", points: ["好的"], verdict: "good_to_know" });
  const KANA_OR_HANGUL = (input: any) => {
    const hangul = /[가-힣]/.test(input.content);
    const text = hangul ? HANGUL : KANA;
    return { summary: text, key_fact: hangul ? "메모" : "メモ", points: [text], verdict: "good_to_know" };
  };
  const CASES: {
    name: string;
    texts: string[];
    account: "en" | "zh";
    mine?: boolean;
    analysis?: (input: any) => unknown;
    secondAskUnusable?: boolean;
    prompt: string;
    sentence: string;
  }[] = [
    {
      name: "switch off, most of the day in Chinese, an English account: Chinese was asked for, so the core's sentence is Chinese",
      texts: [ZH_TEXT, ZH_TEXT_2, EN_TEXT],
      account: "en",
      prompt: "Write in 简体中文 (most of the analyses are in it)",
      sentence: "这份每日摘要汇总了 3 条解读。",
    },
    {
      name: "switch off, most of the day in English, a Chinese account: the item's language was asked for, so the core's sentence is English",
      texts: [EN_TEXT, EN_TEXT_2, ZH_TEXT],
      account: "zh",
      prompt: "Write in the language the item's own text is written in (most of the analyses are in it)",
      sentence: "This daily digest covers 3 analyses.",
    },
    {
      name: "switch off, an even split, an English account: the account's language",
      texts: [ZH_TEXT, EN_TEXT],
      account: "en",
      prompt: "Write in English, whatever language the analyses are in: translate what you report",
      sentence: "This daily digest covers 2 analyses.",
    },
    {
      name: "switch off, an even split, a Chinese account: the account's language",
      texts: [ZH_TEXT, EN_TEXT],
      account: "zh",
      prompt: "Write in 简体中文, whatever language the analyses are in: translate what you report",
      sentence: "这份每日摘要汇总了 2 条解读。",
    },
    {
      name: "switch on, most of the day in Chinese, an English account: the account's language (English)",
      texts: [ZH_TEXT, ZH_TEXT_2],
      account: "en",
      mine: true,
      prompt: "Write in English, whatever language the analyses are in: translate what you report",
      sentence: "This daily digest covers 2 analyses.",
    },
    {
      name: "switch on, most of the day in English, a Chinese account: the account's language (Chinese)",
      texts: [EN_TEXT, EN_TEXT_2],
      account: "zh",
      mine: true,
      prompt: "Write in 简体中文, whatever language the analyses are in: translate what you report",
      sentence: "这份每日摘要汇总了 2 条解读。",
    },
    {
      name: "switch off, the day's analyses are too short to tell, an English account: the account's language (English), whatever the saved texts are in",
      texts: [ZH_TEXT, EN_TEXT, EN_TEXT_2],
      account: "en",
      analysis: TOO_SHORT,
      prompt: "Write in English, whatever language the analyses are in: translate what you report",
      sentence: "This daily digest covers 3 analyses.",
    },
    {
      name: "switch off, the day's analyses are too short to tell, a Chinese account: the account's language (Chinese), whatever the saved texts are in",
      texts: [EN_TEXT, EN_TEXT_2, ZH_TEXT],
      account: "zh",
      analysis: TOO_SHORT,
      prompt: "Write in 简体中文, whatever language the analyses are in: translate what you report",
      sentence: "这份每日摘要汇总了 3 条解读。",
    },
    {
      name: "switch off, the day's analyses are in kana and Hangul (cannot be told), an English account: the account's language (English)",
      texts: [KANA, HANGUL],
      account: "en",
      analysis: KANA_OR_HANGUL,
      prompt: "Write in English, whatever language the analyses are in: translate what you report",
      sentence: "This daily digest covers 2 analyses.",
    },
    {
      name: "switch off, the day's analyses are in kana and Hangul (cannot be told), a Chinese account: the account's language (Chinese)",
      texts: [KANA, HANGUL],
      account: "zh",
      analysis: KANA_OR_HANGUL,
      prompt: "Write in 简体中文, whatever language the analyses are in: translate what you report",
      sentence: "这份每日摘要汇总了 2 条解读。",
    },
    {
      name: "the second ask gets no usable answer, most of the day in Chinese, an English account: the sentence is Chinese, as the asks were",
      texts: [ZH_TEXT, ZH_TEXT_2, EN_TEXT],
      account: "en",
      secondAskUnusable: true,
      prompt: "Write in 简体中文 (most of the analyses are in it)",
      sentence: "这份每日摘要汇总了 3 条解读。",
    },
    {
      name: "the second ask gets no usable answer, most of the day in English, a Chinese account: the sentence is English, as the asks were",
      texts: [EN_TEXT, EN_TEXT_2, ZH_TEXT],
      account: "zh",
      secondAskUnusable: true,
      prompt: "Write in the language the item's own text is written in (most of the analyses are in it)",
      sentence: "This daily digest covers 3 analyses.",
    },
  ];
  for (const c of CASES) {
    it(c.name, async () => {
      const { asked, digest } = await fallbackDigest(c.texts, { account: c.account, mine: c.mine, analysis: c.analysis, secondAskUnusable: c.secondAskUnusable });
      // Two asks, both wrong: the sentence is the core's own, and it is in the language of the last prompt.
      expect(asked).toHaveLength(2);
      for (const a of asked) expect(a.request.system).toContain(c.prompt);
      expect(digest.summary).toBe(c.sentence);
      expect(digest.counts.saved).toBe(c.texts.length);
    });
  }

  it("the model's own question is kept, and nothing else of its summary", async () => {
    const { digest } = await fallbackDigest([ZH_TEXT, ZH_TEXT_2, EN_TEXT], { account: "en" });
    expect(digest.question).toBe("明天做什么？");
    expect(digest.summary).not.toMatch(/4/);
  });
});

describe("P5: the switch is an account setting", () => {
  it("is off by default, can be turned on and off, and is refused when it is not a boolean", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.always_my_language).toBe(false);
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: true } })).json.always_my_language).toBe(true);
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json).toMatchObject({ always_my_language: true, lang: "en" });
    // Changing the language does not touch it, and changing it does not touch the language.
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { lang: "zh" } })).json).toMatchObject({ always_my_language: true, lang: "zh" });
    expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: false } })).json).toMatchObject({ always_my_language: false, lang: "zh" });
    for (const bad of ["yes", 1, null, "true"]) expect((await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: bad } })).status).toBe(400);
    expect((await call(env, "GET", "/v1/settings", { token: ann.token })).json.always_my_language).toBe(false);
  });

  it("is in the account's download, and is told to an assistant that asks for the rules", async () => {
    const env = makeEnv();
    const { ann, helper } = await withHelper(env);
    expect((await tool(env, helper.access, "get_rules", { kind: "analysis" })).data).toMatchObject({ lang: "en", always_my_language: false });
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: true } });
    const rules = (await call(env, "GET", "/v1/assistant/rules?kind=analysis", { token: helper.access })).json;
    expect(rules).toMatchObject({ lang: "en", always_my_language: true });
    expect((await tool(env, helper.access, "get_rules", { kind: "analysis" })).data).toEqual(rules);
    const exported = await call(env, "GET", "/v1/export", { token: ann.token });
    expect(exported.status).toBe(200);
    expect((exported.json ?? JSON.parse(exported.text)).settings).toMatchObject({ lang: "en", always_my_language: true });
  });

  it("is on its own per account", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const bob = await signIn(env, "bob@example.com");
    await call(env, "PATCH", "/v1/settings", { token: ann.token, body: { always_my_language: true } });
    expect((await call(env, "GET", "/v1/settings", { token: bob.token })).json.always_my_language).toBe(false);
  });
});
