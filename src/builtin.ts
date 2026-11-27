// The two built-in assistants. They have their own identities and steps, and they work through
// the same service functions as any connected assistant: ask for work, claim, read the rules and
// the context, hand results back. Nothing here writes to the database directly.
import { now } from "./clock";
import { LIMITS, num, type Env } from "./env";
import type { Lang } from "./errors";
import { builtinActor, getUser } from "./services/accounts";
import { askModel, callModel, extractJson, modelConfigured, type ContentBlock, type ModelBudget } from "./services/model";
import { digestDue } from "./services/digests";
import { fallbackSummary, wrongTotal } from "./services/digestcheck";
import { ANALYSIS_MAX_ATTEMPTS, capLeft, claimWork, digestCallsSpent, getContext, getDigestContext, getRules, noteAnalysisFailure, recordUnsubmittedUsage, recordUnusedUsage, releaseClaim, submitResults, type UsageInput } from "./services/work";
import type { AssistantActor, UserRow } from "./types";
import { shorten, truncate } from "./util";

const LANG_NAME: Record<Lang, string> = { zh: "简体中文", en: "English" };
const VERDICTS = ["worth_deep_dive", "good_to_know", "skippable"];

async function seen(env: Env, actor: AssistantActor): Promise<void> {
  await env.DB.prepare("UPDATE assistants SET last_seen_at = ? WHERE id = ? AND user_id = ?").bind(now(), actor.assistantId, actor.userId).run();
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? shorten(value.replace(/\s+/g, " ").trim(), max) : undefined;
}

// ---------------------------------------------------------------- dispatch assistant (step: triage)

/** One round for one user: claim a few waiting items, ask the model once, hand the tags back. */
export async function dispatchForUser(env: Env, userId: string): Promise<number> {
  const actor = await builtinActor(env, userId, "dispatch");
  if (!actor) return 0;
  const claim = await claimWork(env, actor, "triage", num(env.TRIAGE_BATCH, 5));
  if (!claim.claim_id) return 0;
  await seen(env, actor);
  try {
    const rules = await getRules(env, actor, "triage");
    const contexts = await Promise.all(claim.work.map((w) => getContext(env, actor, w.ref, "triage", "")));
    const candidates = rules.assistants.filter((a) => a.steps.includes("analysis")).map((a) => a.name);
    const hasRules = rules.rules.trim().length > 0;
    const reply = await callModel(env, {
      timeoutMs: 10_000,
      maxTokens: 1500,
      system:
        "You sort saved items. For each item decide which assistant analyses it and how many days it is kept. " +
        "You see only the title, the site and the opening of each item. Decide only what the user's rules decide: set `assistant` or `expiry_days` for an item only when the rules say who analyses such an item or how long it is kept. " +
        "Never choose on your own judgement of the content; when the rules do not cover it, leave the field out and the default applies. " +
        'Answer with JSON only: an array of {"item_id": string, "assistant"?: string, "expiry_days"?: number}. ' +
        "`assistant` must be exactly one of the listed names. `expiry_days` must be one of the listed options.",
      content: JSON.stringify({
        rules: rules.rules,
        assistants: candidates,
        default_assistant: rules.default_analysis_assistant,
        expiry_options: rules.expiry_options,
        items: contexts.map((c) => ({ item_id: c.item.id, kind: c.item.kind, title: c.item.title, site: c.item.site, opening: c.item.opening })),
      }),
    });
    if (!reply) {
      // No answer in time: put the items back. The core gives them defaults after 10 minutes.
      await releaseClaim(env, actor, claim.claim_id);
      return 0;
    }
    const parsed = extractJson(reply.text);
    const list: any[] = Array.isArray(parsed) ? parsed : Array.isArray((parsed as any)?.items) ? (parsed as any).items : [];
    const byId = new Map(list.filter((x) => x && typeof x.item_id === "string").map((x) => [x.item_id, x]));
    const results = claim.work.map((w) => {
      const x = byId.get(w.ref);
      const result: Record<string, unknown> = { kind: "triage", item_id: w.ref };
      // Anything the model made up is dropped; the core then fills in the default.
      if (x && typeof x.assistant === "string" && candidates.includes(x.assistant)) result.assistant = x.assistant;
      // Without rules from the user there is nothing to decide by: the default stands (QA #32, #40).
      if (x && hasRules && rules.expiry_options.includes(x.expiry_days)) result.expiry_days = x.expiry_days;
      return result;
    });
    const usage: UsageInput = { model: reply.model, input_tokens: reply.inputTokens, output_tokens: reply.outputTokens, calls: 1 };
    const { outcomes } = await submitResults(env, actor, claim.claim_id, results, usage, rules.lang as Lang);
    return outcomes.filter((o) => o.accepted).length;
  } catch (e) {
    console.error("dispatch failed", e);
    await releaseClaim(env, actor, claim.claim_id).catch(() => {});
    return 0;
  }
}

// ---------------------------------------------------------------- worker assistant (steps: analysis, digest)

/**
 * What a piece of writing is to be in, and what its language check looks for (QA #18, Cheney's option 2).
 * `name` is what the model is told. `check` is what the answer is judged against: "zh" for Chinese; "en" means
 * "not in another script" (Latin script), because the script cannot tell English from French. `from` says why:
 * the account (the switch is on, or the item's own language cannot be told) or the item itself.
 */
export interface Target {
  name: string;
  check: Lang;
  from: "account" | "item";
}

const accountTarget = (lang: Lang): Target => ({ name: LANG_NAME[lang], check: lang, from: "account" });

/**
 * The language of an item's own text, by script: Chinese, Latin, or null when it cannot be told (fewer than five
 * letters, or kana, Hangul, Cyrillic ... which are neither). Same thresholds as `writtenIn`, so a text that is
 * "zh" is one that `writtenIn("zh", …)` accepts and a text that is "latin" is one that `writtenIn("en", …)` does.
 */
export function scriptOf(text: string): "zh" | "latin" | null {
  const { letters, han, foreign } = scriptsOf(text);
  if (letters < MIN_JUDGED_LETTERS) return null;
  if (han / letters >= 0.3 && foreign / letters < 0.2) return "zh";
  if ((han + foreign) / letters < 0.3) return "latin";
  return null;
}

const itemTarget = (script: "zh" | "latin"): Target =>
  script === "zh" ? { name: LANG_NAME.zh, check: "zh", from: "item" } : { name: "the language the item's own text is written in", check: "en", from: "item" };

/** The language of one analysis: the account's when the switch is on or the item's cannot be told, else the item's own. */
export function analysisTarget(account: Lang, alwaysMine: boolean, ownText: string): Target {
  if (alwaysMine) return accountTarget(account);
  const script = scriptOf(ownText);
  return script ? itemTarget(script) : accountTarget(account);
}

/** The language of a daily digest: the one most of the day's analyses are written in; an even split, or none to go by, the account's. */
export function digestTarget(account: Lang, alwaysMine: boolean, summaries: string[]): Target {
  if (alwaysMine) return accountTarget(account);
  const count = { zh: 0, latin: 0 };
  for (const text of summaries) {
    const script = scriptOf(text);
    if (script) count[script]++;
  }
  if (count.zh === count.latin) return accountTarget(account);
  return itemTarget(count.zh > count.latin ? "zh" : "latin");
}

/**
 * The language of the writing, said again where the model cannot miss it: an item in another language, a title or
 * rules in it, make a model write in that language unless told, in so many words, to translate (or not to).
 */
const languageRule = (t: Target) =>
  t.from === "account"
    ? `Every text field you write (summary, key_fact, points, related_hint) is in ${t.name}, whatever language the item, its title or the owner's rules are written in: ` +
      `translate what you report, do not answer in the item's language. Names and short quotations may stay as they are.`
    : `Every text field you write (summary, key_fact, points, related_hint) is in ${t.name}, whatever language the item's title or the owner's rules are written in: ` +
      `do not translate it into another language. Names and short quotations may stay as they are.`;

/** Letters by script: Latin, Han, kana, and everything else (Hangul, Cyrillic, Arabic ...). */
function scriptsOf(text: string): { letters: number; latin: number; han: number; foreign: number } {
  // What is not the writer's own words is left out: addresses and quotations (a quoted title may be in any language).
  const own = text
    .replace(/https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+/g, " ")
    .replace(/“[^”]*”|"[^"]*"|「[^」]*」|『[^』]*』|《[^》]*》|«[^»]*»/g, " ");
  let latin = 0;
  let han = 0;
  let foreign = 0;
  for (const ch of own) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) latin++;
    else if (/\p{Script=Han}/u.test(ch)) han++;
    else foreign++; // kana, Hangul, Cyrillic ...: neither English nor Chinese
  }
  return { letters: latin + han + foreign, latin, han, foreign };
}

/** Fewer letters than this is a name, an acronym or a short quotation (PDF 3 页, 张伟, "ok"): it is not judged. */
const MIN_JUDGED_LETTERS = 5;

/**
 * Is this one text in the language the owner reads? A judgement by script, **a heuristic, not language
 * identification**: for English, less than 30% of the letters are Chinese characters, kana or other
 * non-Latin script; for 简体中文, at least 30% are Chinese characters and less than 20% are kana or other
 * non-Latin, non-Chinese script (so Japanese does not pass). Numbers, symbols, addresses and quoted words
 * are left out, and so is a text with fewer than five letters. Judge each field on its own: a long answer
 * in the right language in one field must not hide another field written in the wrong one.
 */
export function writtenIn(lang: Lang, text: string): boolean {
  const { letters, han, foreign } = scriptsOf(text);
  if (letters < MIN_JUDGED_LETTERS) return true;
  return lang === "zh" ? han / letters >= 0.3 && foreign / letters < 0.2 : (han + foreign) / letters < 0.3;
}

/** The text fields of an analysis, by name. */
const fieldsOf = (x: any): [string, string][] => [
  ["summary", x?.summary],
  ["key_fact", x?.key_fact],
  ...(Array.isArray(x?.points) ? x.points.map((p: unknown, i: number): [string, unknown] => [`points[${i}]`, p]) : []),
  ["related_hint", x?.related_hint],
].filter((f): f is [string, string] => typeof f[1] === "string" && f[1].trim() !== "");

/** The fields of an answer that are not in the language, by name. Empty when every field is. */
export function wrongLanguageFields(lang: Lang, x: any): string[] {
  return fieldsOf(x).filter(([, text]) => !writtenIn(lang, text)).map(([name]) => name);
}

const hasPoints = (x: any): boolean => Array.isArray(x?.points) && x.points.some((p: unknown) => typeof p === "string" && p.trim());

const ANALYSIS_SYSTEM = (target: Target) =>
  `You analyse one saved item for its owner. Write in ${target.name}. Answer with JSON only, with exactly these fields:\n` +
  `{"summary": one complete sentence saying what the item is about: at most 60 characters in Chinese or 25 words in a language written with spaces (never more than ${LIMITS.analysis_summary_max_chars} characters);\n` +
  ` "key_fact": one line, at most ${LIMITS.analysis_key_fact_max_chars} characters, that fits the kind of content (article: author and length; video: duration; repository: language and stars; screenshot: the main thing in it; post: author and platform; text: word count; file: format and pages);\n` +
  ` "points": 1 to ${LIMITS.analysis_points_max} complete sentences with the substance (always at least one, however short the item is), each at most ${LIMITS.analysis_point_max_chars} characters;\n` +
  ` "verdict": "worth_deep_dive" | "good_to_know" | "skippable";\n` +
  ` "related_hint": optional, one sentence naming an earlier item, digest or note of the owner (from "related") that this connects to. Leave it out if nothing connects.}\n` +
  `Judge by the owner's rules if they say what matters. When "length" is given and the key fact mentions how long the text is, use exactly the numbers in it and do not count yourself; mention only what it lists, and do not say where the numbers came from. Never state when the item was saved, in any field: the owner sees that beside the item, and a date or time written in the title or the text is part of the content, not the moment of saving (if it matters, report it as what the text says). Every field must be a finished thought that fits its limit: write shorter rather than be cut off. Do not copy long passages. If you cannot read the content at all, answer {"unavailable": true}.` +
  ` "content" is the author's own text. When "recognized_text" is given, it was recognized from the sound of the item's video: it is not the author's words and it may contain mistakes. Write "the video says …" when you rely on it, never present it as the author's text, and do not take a name or a number in it as fact. If the duration of a video is not given, do not state one.` +
  ` ${languageRule(target)}`;

/** The length of a text as a reader would count it: words for text written with spaces, characters for Chinese, Japanese and Korean. */
export function textLength(text: string): { words: number; cjk_characters: number } {
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, cjk_characters: cjk };
}

/** Only the counts that are not zero, so the model has nothing empty to report. */
function nonZero(length: { words: number; cjk_characters: number }): Record<string, number> {
  return Object.fromEntries(Object.entries(length).filter(([, n]) => n > 0));
}

/** What was paid for one item: every model reply that came back, whether or not it was used. */
type Spent = { input: number; output: number; model: string; calls: number };
type Analysed = { result: Record<string, unknown>; usage: Spent | null } | { failure: string; usage?: Spent | null };

const unavailable = (itemId: string, usage: Spent | null = null): Analysed => ({
  result: { kind: "analysis", item_id: itemId, unavailable: true },
  usage,
});

/** What the model is shown of a file with no text: an image or a PDF, fetched by the model from the core's signed https address. */
export function fileBlock(type: string | null | undefined, url: string | null | undefined): ContentBlock | null {
  if (!url || !/^https:\/\//.test(url)) return null;
  if (type?.startsWith("image/")) return { type: "image", source: { type: "url", url } };
  if (type === "application/pdf") return { type: "document", source: { type: "url", url } };
  return null;
}

/** How much of an item's text the model is shown: the author's text first, then the beginning of what was recognized from the video. */
const CONTENT_CHARS = 24_000;
/** The recognized text gets at least this much room when there is that much of it, whatever the author wrote. */
const RECOGNIZED_MIN_CHARS = 8_000;

export function shownText(body: string | null | undefined, recognized: string | null | undefined): { content: string; recognized_text?: string } {
  const author = body ?? "";
  if (!recognized) return { content: truncate(author, CONTENT_CHARS) };
  const room = Math.min(recognized.length, Math.max(RECOGNIZED_MIN_CHARS, CONTENT_CHARS - author.length));
  return { content: truncate(author, CONTENT_CHARS - room), recognized_text: truncate(recognized, room) };
}

async function analyseOne(env: Env, actor: AssistantActor, itemId: string, rules: Awaited<ReturnType<typeof getRules>>, origin: string): Promise<Analysed> {
  const ctx = await getContext(env, actor, itemId, "analysis", origin);
  if (ctx.item.content_unavailable) return unavailable(itemId);
  // The item's own words are its title, its text and what was recognized from its video: not the owner's rules, not a related item.
  const target = analysisTarget(rules.lang as Lang, rules.always_my_language === true, [ctx.item.title, ctx.item.body, ctx.item.recognized_text].filter(Boolean).join("\n"));
  const facts = {
    write_in: target.name,
    kind: ctx.item.kind,
    title: ctx.item.title,
    site: ctx.item.site,
    saved_at: ctx.item.saved_at,
    rules: rules.rules,
    related: ctx.related,
    // Counted here, not by the model: the same text must always get the same number.
    length: ctx.item.body ? nonZero(textLength(ctx.item.body)) : null,
    ...shownText(ctx.item.body, ctx.item.recognized_text),
  };
  // `correction` is added to the facts when an answer has to be asked for again.
  let contentFor = (correction?: string): string | ContentBlock[] => JSON.stringify(correction ? { ...facts, correction } : facts);
  if (!ctx.item.body && !ctx.item.recognized_text) {
    // No text. An image or a PDF is looked at by the model itself; a text file's content would
    // already be the body, so anything else here has nothing to read.
    const block = fileBlock(ctx.item.asset_type, ctx.item.asset_url);
    if (!block) {
      console.warn(`analysis of ${itemId}: no content (${ctx.item.asset_url ? `a ${ctx.item.asset_type ?? "file"} the model cannot be given` : "no text and no file"})`);
      return unavailable(itemId);
    }
    contentFor = (correction) => [block, { type: "text", text: JSON.stringify(correction ? { ...facts, correction } : facts) }];
  }
  let why = "no reply";
  // One budget for everything asked about this item: the first answer may take up to 25 seconds, the
  // correction gets what is left of the total (40 s unless ANALYSIS_BUDGET_MS says otherwise) and is
  // not asked for at all with less than 8 s left; at most 3 HTTP requests in all (two answers, and
  // one more if the gateway refuses the `effort` field once). Best effort: it does not promise that a
  // second answer is compliant, only that the whole costs a bounded time and number of requests.
  const total = num(env.ANALYSIS_BUDGET_MS, 40_000);
  const budget: ModelBudget = { until: Date.now() + total, requests: 3 };
  // Every reply that comes back is paid for, whether or not it is the one that is used.
  const spent: Spent = { input: 0, output: 0, model: "", calls: 0 };
  const paid = (r: { inputTokens: number; outputTokens: number; model: string }) => {
    spent.input += r.inputTokens;
    spent.output += r.outputTokens;
    spent.model = r.model;
    spent.calls++;
  };
  let noEffort = false;
  const ask = async (correction?: string) => {
    const r = await callModel(env, { timeoutMs: 25_000, budget, noEffort, maxTokens: 2000, system: ANALYSIS_SYSTEM(target), content: contentFor(correction), onFailure: (reason) => (why = reason), onUnusedReply: paid });
    if (r) {
      paid(r);
      if (r.effortRefused) noEffort = true;
    }
    return r;
  };
  const used = (): Spent | null => (spent.calls > 0 ? { ...spent } : null);
  const first = await ask();
  // A first reply with nothing to use may still have been paid for (a refusal that reported its usage).
  if (!first) return { failure: why, usage: used() };
  let x = extractJson(first.text) as any;
  // An answer is asked for once more when it has no key point (QA #69) or a field is not in the
  // language the owner reads (QA #18, core#2). The second answer replaces the first only when it is
  // better: one that can be handed in (a summary and a verdict) beats one that cannot, and between
  // two that can, the one with fewer of the two flaws wins. With the same number the first stands, and
  // so it does when the second is not JSON, says "unavailable" or cannot be handed in: an item is never
  // called unreadable, nor loses an answer it could have had, for either flaw.
  const flaws = (a: any) => ({ points: !hasPoints(a), language: wrongLanguageFields(target.check, a).length > 0 });
  const worse = (a: any) => Number(flaws(a).points) + Number(flaws(a).language);
  const sound = (a: any) => Boolean(str(a.summary, LIMITS.analysis_summary_max_chars)) && VERDICTS.includes(a.verdict);
  const better = (y: any, x: any) => (sound(y) !== sound(x) ? sound(y) : worse(y) < worse(x));
  if (x && typeof x === "object" && x.unavailable !== true) {
    const bad = flaws(x);
    const timeLeft = budget.until - Date.now() >= Math.min(8_000, total / 2);
    if ((bad.points || bad.language) && timeLeft && budget.requests > 0) {
      const notes = [
        bad.language
          ? `Your previous answer was not in ${target.name}. Write every text field in ${target.name}${target.from === "account" ? ", translating from the item" : ", and do not translate it into another language"}.`
          : "",
        bad.points ? "Your previous answer had no key point. Give at least one complete sentence in \"points\"." : "",
      ].filter(Boolean);
      const again = await ask(notes.join(" "));
      const y = again ? (extractJson(again.text) as any) : null;
      if (y && typeof y === "object" && y.unavailable !== true && better(y, x)) x = y;
    }
  }
  if (!x || typeof x !== "object") return { failure: "the reply is not JSON", usage: used() };
  if (x.unavailable === true) return unavailable(itemId, used());
  const summary = str(x.summary, LIMITS.analysis_summary_max_chars);
  if (!summary || !VERDICTS.includes(x.verdict)) return { failure: "the reply lacks a summary or a verdict", usage: used() };
  const result: Record<string, unknown> = {
    kind: "analysis",
    item_id: itemId,
    summary,
    verdict: x.verdict,
    points: (Array.isArray(x.points) ? x.points : []).map((p: unknown) => str(p, LIMITS.analysis_point_max_chars)).filter(Boolean).slice(0, LIMITS.analysis_points_max),
  };
  const keyFact = str(x.key_fact, LIMITS.analysis_key_fact_max_chars);
  if (keyFact) result.key_fact = keyFact;
  const hint = str(x.related_hint, 200);
  if (hint) result.related_hint = hint;
  return { result, usage: used() };
}

/** What the user reads when the built-in assistant gave up on an item. */
const COULD_NOT_READ: Record<Lang, string> = { zh: "内容读不出来", en: "Content could not be read" };

/** One round of analyses for one user, within the daily cap. */
export async function analyseForUser(env: Env, userId: string, origin: string): Promise<number> {
  const actor = await builtinActor(env, userId, "worker");
  if (!actor) return 0;
  if (!modelConfigured(env)) {
    console.warn("analysis skipped: no credential (LLM_API_KEY is not set)");
    return 0;
  }
  const user = await getUser(env, userId);
  const left = await capLeft(env, user, "analysis", num(env.ANALYSIS_PER_USER_PER_DAY, 200));
  if (left === 0) return 0;
  const claim = await claimWork(env, actor, "analysis", Math.min(num(env.ANALYSIS_BATCH, 2), left));
  if (!claim.claim_id) return 0;
  await seen(env, actor);
  try {
    const rules = await getRules(env, actor, "analysis");
    const tried = await Promise.all(
      claim.work.map((w) => analyseOne(env, actor, w.ref, rules, origin).catch((e): Analysed => ({ failure: `error: ${e instanceof Error ? e.message : String(e)}` }))),
    );
    const done: { result: Record<string, unknown>; usage: Spent | null }[] = [];
    for (const [i, outcome] of tried.entries()) {
      if ("result" in outcome) {
        done.push(outcome);
        continue;
      }
      // A failure is counted per item. After the third, the item is handed in as unreadable, so
      // that the user sees the truth and the model is not asked about it every minute for ever.
      const itemId = claim.work[i].ref;
      const attempts = await noteAnalysisFailure(env, actor, itemId);
      // The model's side being down (5xx, 429, no answer) says nothing about the item: such
      // failures get a far higher limit, so a short outage does not mark items unreadable.
      const outage = /(^| )(5\d\d|429)$|^no reply within|^request failed/.test(outcome.failure);
      const limit = outage ? ANALYSIS_MAX_ATTEMPTS * 20 : ANALYSIS_MAX_ATTEMPTS;
      const last = attempts >= limit;
      console.warn(`analysis of ${itemId} failed (attempt ${attempts} of ${limit}): ${outcome.failure}${last ? "; handed in as unreadable" : ""}`);
      if (last) done.push({ result: { kind: "analysis", item_id: itemId, unavailable: true, summary: COULD_NOT_READ[rules.lang as Lang] ?? COULD_NOT_READ.en }, usage: null });
    }
    // Every reply the model sent back was paid for, an item's discarded second answer and an item that
    // failed included: the usage is the sum of what every item cost.
    const spent = tried.flatMap((o) => (o.usage ? [o.usage] : []));
    const usage: UsageInput = {
      model: spent[0]?.model,
      input_tokens: spent.reduce((n, u) => n + u.input, 0),
      output_tokens: spent.reduce((n, u) => n + u.output, 0),
      calls: spent.reduce((n, u) => n + u.calls, 0),
    };
    let accepted = 0;
    if (done.length > 0) {
      const { outcomes } = await submitResults(env, actor, claim.claim_id, done.map((d) => d.result), usage, user.lang);
      accepted = outcomes.filter((o) => o.accepted).length;
    } else if (usage.calls) {
      await recordUnsubmittedUsage(env, actor, claim.claim_id, "analysis", usage);
    }
    // Whatever was not handed in goes back for the next round.
    if (accepted < claim.work.length) await releaseClaim(env, actor, claim.claim_id);
    return accepted;
  } catch (e) {
    console.error("analysis failed", e);
    await releaseClaim(env, actor, claim.claim_id).catch(() => {});
    return 0;
  }
}

const DIGEST_SYSTEM = (target: Target) =>
  `You write the owner's daily digest from the analyses of what they saved. Write in ${target.name}${target.from === "account" ? ", whatever language the analyses are in: translate what you report" : " (most of the analyses are in it): do not translate it into another language"}. Plain text, no images, no tags, no long quotes. Answer with JSON only:\n` +
  `{"summary": a few sentences on what was saved, at most 600 characters. The input's "total" is how many items this digest covers: if the summary says how many items were saved or covered, it says exactly that number; when unsure, it says no number;\n` +
  ` "worth": [{"item_id": string, "line": one sentence with the conclusion, at most 160 characters}] — only items whose verdict is worth_deep_dive and that the owner has not marked (signal is null) and has not queued;\n` +
  ` "question": one question to sleep on, at most 160 characters}`;

/**
 * How many answers the model is paid for one digest, in all: the first, and one more when its summary does not agree with
 * the snapshot (core#3). The count is kept across Cron runs (a run that finds the answer unusable gives the claim back, and
 * the next run must not begin again), from what the calls were recorded as costing.
 */
const DIGEST_ASKS = 2;

/** Writes the daily digest for one user if it is due (after 21:00 in their time zone) and theirs to write. */
export async function digestForUser(env: Env, user: UserRow): Promise<boolean> {
  const actor = await builtinActor(env, user.id, "worker");
  if (!actor || user.role_digest !== actor.assistantId) return false;
  if (!(await digestDue(env, user))) return false;
  if ((await capLeft(env, user, "digest", num(env.DIGEST_PER_USER_PER_DAY, 1))) === 0) return false;
  const claim = await claimWork(env, actor, "digest", 1);
  if (!claim.claim_id) return false;
  await seen(env, actor);
  let paid = false; // the cost of the model's answers is on record: with the hand-in, or on its own
  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let model: string | undefined;
  /** What the answers cost, when no hand-in carries it. */
  const recordSpent = async () => {
    if (paid || calls === 0) return;
    paid = true;
    await recordUnusedUsage(env, actor, claim.claim_id!, { model, input_tokens: inputTokens, output_tokens: outputTokens, calls }).catch((e) => console.error("digest usage not recorded", e));
  };
  try {
    const day = claim.work[0].ref;
    // The budget of this digest, whatever earlier runs spent: when it is gone the model is not asked again today.
    const asksLeft = DIGEST_ASKS - (await digestCallsSpent(env, user.id, day));
    if (asksLeft <= 0) {
      console.warn(`digest of ${day} not written: the model has already answered ${DIGEST_ASKS} times for it`);
      await releaseClaim(env, actor, claim.claim_id);
      return false;
    }
    let ctx = await getDigestContext(env, actor, day);
    // What the digest is written in: the language most of the day's analyses are in (the account's when the switch is on, or no majority).
    const targetOf = (c: typeof ctx) => digestTarget(user.lang, user.always_my_language === 1, c.analyses.filter((a) => !a.unavailable).map((a) => a.summary));
    let correction: string | undefined;
    let first: { summary: string; question: string; worth: unknown } | null = null;
    let summary: string | undefined;
    let question: string | undefined;
    let worthRaw: unknown;
    for (let ask = 1; ask <= asksLeft; ask++) {
      const answer = await askModel(env, {
        timeoutMs: 25_000,
        maxTokens: 4000,
        system: DIGEST_SYSTEM(targetOf(ctx)),
        content: JSON.stringify({ ...ctx, total: ctx.analyses.length, ...(correction ? { correction } : {}) }),
      });
      // An answer that was paid for is on record and spends one of the digest's two, whether or not its text can be used
      // (an empty answer or a refusal that carries its usage was paid for too). A call that got no answer costs nothing and
      // is not made up a cost.
      if (answer.cost) {
        calls++;
        model = answer.cost.model;
        inputTokens += answer.cost.inputTokens;
        outputTokens += answer.cost.outputTokens;
      }
      const reply = answer.reply;
      const x = reply ? (extractJson(reply.text) as any) : null;
      const said = str(x?.summary, 600);
      const asked = str(x?.question, 160);
      if (!reply || !said || !asked) {
        // The first answer unusable: nothing to go on, the next round tries again (within what is left of the budget). A later one: the first answer's question and worth stand.
        if (!first) {
          await recordSpent();
          await releaseClaim(env, actor, claim.claim_id);
          return false;
        }
        break;
      }
      summary = said;
      question = asked;
      worthRaw = x.worth;
      first ??= { summary: said, question: asked, worth: x.worth };
      // The set can have grown while the model wrote (an analysis landing before midnight): what is checked against is what is there now.
      const fresh = await getDigestContext(env, actor, day);
      const stated = wrongTotal(said, fresh.analyses.length);
      ctx = fresh;
      if (stated === null) break;
      correction = `Your summary said ${stated} items, but this digest covers ${fresh.analyses.length}. Write the summary again: say ${fresh.analyses.length}, or give no number.`;
      summary = undefined;
    }
    if (!first) {
      await recordSpent();
      await releaseClaim(env, actor, claim.claim_id);
      return false;
    }
    // Still not in agreement after the second ask (or the second ask failed): the summary is the snapshot's own sentence, never the model's number.
    if (summary === undefined) {
      summary = fallbackSummary(ctx.analyses.length, user.lang);
      question = first.question;
      worthRaw = first.worth;
    }
    const known = new Set(ctx.analyses.map((a) => a.item_id));
    const used = new Set<string>();
    const worth: { item_id: string; line: string }[] = [];
    for (const w of Array.isArray(worthRaw) ? worthRaw : []) {
      const line = str(w?.line, 160);
      if (!line || typeof w.item_id !== "string" || !known.has(w.item_id) || used.has(w.item_id)) continue;
      used.add(w.item_id);
      worth.push({ item_id: w.item_id, line });
    }
    const usage: UsageInput = { model, input_tokens: inputTokens, output_tokens: outputTokens, calls };
    const { outcomes } = await submitResults(env, actor, claim.claim_id, [{ kind: "digest", day, summary, worth: worth.slice(0, 50), question }], usage, user.lang);
    paid = true; // the hand-in recorded it
    return outcomes[0]?.accepted === true;
  } catch (e) {
    console.error("digest failed", e);
    await recordSpent();
    await releaseClaim(env, actor, claim.claim_id).catch(() => {});
    return false;
  }
}

export { modelConfigured };
