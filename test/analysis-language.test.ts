// core#2 / QA #18: a new analysis is written in the language the account has, whatever language the
// item is in, in both directions, and also straight after the language was changed. The model is a
// stand-in that (like the real one) mirrors the item's language unless it is told to translate.
import { describe, expect, it } from "vitest";
import { writtenIn } from "../src/builtin";
import { runMinute } from "../src/cron";
import { builtinModel, call, db, LLM, makeEnv, saveText, signIn } from "./helpers";

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
    const ann = await signIn(env);
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
    const ann = await signIn(env);
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
    const ann = await signIn(env);
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
    const ann = await signIn(env);
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
    const ann = await signIn(env);
    await saveText(env, ann.token, ZH_TEXT);
    await runMinute(env);
    expect(analysisCalls(calls)).toHaveLength(1);
  });

  it("a model that never writes in the language is asked twice, and the item is analysed all the same", async () => {
    const calls: any[] = [];
    const env = makeEnv({ ...LLM, OUTBOUND: builtinModel(calls, { analysis: () => chinese }) });
    const ann = await signIn(env);
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
    const ann = await signIn(env);
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
    const ann = await signIn(env);
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
