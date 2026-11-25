// The two built-in assistants. They have their own identities and steps, and they work through
// the same service functions as any connected assistant: ask for work, claim, read the rules and
// the context, hand results back. Nothing here writes to the database directly.
import { now } from "./clock";
import { LIMITS, num, type Env } from "./env";
import type { Lang } from "./errors";
import { builtinActor, getUser } from "./services/accounts";
import { callModel, extractJson, modelConfigured, type ContentBlock } from "./services/model";
import { digestDue } from "./services/digests";
import { ANALYSIS_MAX_ATTEMPTS, capLeft, claimWork, getContext, getDigestContext, getRules, noteAnalysisFailure, releaseClaim, submitResults, type UsageInput } from "./services/work";
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

const ANALYSIS_SYSTEM = (lang: Lang) =>
  `You analyse one saved item for its owner. Write in ${LANG_NAME[lang]}. Answer with JSON only, with exactly these fields:\n` +
  `{"summary": one complete sentence saying what the item is about: at most 60 characters in Chinese or 25 words in a language written with spaces (never more than ${LIMITS.analysis_summary_max_chars} characters);\n` +
  ` "key_fact": one line, at most ${LIMITS.analysis_key_fact_max_chars} characters, that fits the kind of content (article: author and length; video: duration; repository: language and stars; screenshot: the main thing in it; post: author and platform; text: word count; file: format and pages);\n` +
  ` "points": up to ${LIMITS.analysis_points_max} complete sentences with the substance, each at most ${LIMITS.analysis_point_max_chars} characters;\n` +
  ` "verdict": "worth_deep_dive" | "good_to_know" | "skippable";\n` +
  ` "related_hint": optional, one sentence naming an earlier item, digest or note of the owner (from "related") that this connects to. Leave it out if nothing connects.}\n` +
  `Judge by the owner's rules if they say what matters. When "length" is given and the key fact mentions how long the text is, use exactly those numbers and do not count yourself. Every field must be a finished thought that fits its limit: write shorter rather than be cut off. Do not copy long passages. If you cannot read the content at all, answer {"unavailable": true}.`;

/** The length of a text as a reader would count it: words for text written with spaces, characters for Chinese, Japanese and Korean. */
export function textLength(text: string): { words: number; cjk_characters: number } {
  const cjk = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
  const words = text.replace(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return { words, cjk_characters: cjk };
}

type Analysed = { result: Record<string, unknown>; usage: { input: number; output: number; model: string } | null } | { failure: string };

const unavailable = (itemId: string, usage: { input: number; output: number; model: string } | null = null): Analysed => ({
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

async function analyseOne(env: Env, actor: AssistantActor, itemId: string, rules: Awaited<ReturnType<typeof getRules>>, origin: string): Promise<Analysed> {
  const ctx = await getContext(env, actor, itemId, "analysis", origin);
  if (ctx.item.content_unavailable) return unavailable(itemId);
  const facts = {
    kind: ctx.item.kind,
    title: ctx.item.title,
    site: ctx.item.site,
    saved_at: ctx.item.saved_at,
    rules: rules.rules,
    related: ctx.related,
    // Counted here, not by the model: the same text must always get the same number.
    length: ctx.item.body ? textLength(ctx.item.body) : null,
    content: truncate(ctx.item.body ?? "", 24_000),
  };
  let content: string | ContentBlock[] = JSON.stringify(facts);
  if (!ctx.item.body) {
    // No text. An image or a PDF is looked at by the model itself; a text file's content would
    // already be the body, so anything else here has nothing to read.
    const block = fileBlock(ctx.item.asset_type, ctx.item.asset_url);
    if (!block) {
      console.warn(`analysis of ${itemId}: no content (${ctx.item.asset_url ? `a ${ctx.item.asset_type ?? "file"} the model cannot be given` : "no text and no file"})`);
      return unavailable(itemId);
    }
    content = [block, { type: "text", text: JSON.stringify(facts) }];
  }
  let why = "no reply";
  const reply = await callModel(env, { timeoutMs: 25_000, maxTokens: 2000, system: ANALYSIS_SYSTEM(rules.lang as Lang), content, onFailure: (reason) => (why = reason) });
  if (!reply) return { failure: why };
  const usage = { input: reply.inputTokens, output: reply.outputTokens, model: reply.model };
  const x = extractJson(reply.text) as any;
  if (!x || typeof x !== "object") return { failure: "the reply is not JSON" };
  if (x.unavailable === true) return unavailable(itemId, usage);
  const summary = str(x.summary, LIMITS.analysis_summary_max_chars);
  if (!summary || !VERDICTS.includes(x.verdict)) return { failure: "the reply lacks a summary or a verdict" };
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
  return { result, usage };
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
    const done: { result: Record<string, unknown>; usage: { input: number; output: number; model: string } | null }[] = [];
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
    let accepted = 0;
    if (done.length > 0) {
      const calls = done.filter((d) => d.usage);
      const usage: UsageInput = {
        model: calls[0]?.usage?.model,
        input_tokens: calls.reduce((n, d) => n + (d.usage?.input ?? 0), 0),
        output_tokens: calls.reduce((n, d) => n + (d.usage?.output ?? 0), 0),
        calls: calls.length,
      };
      const { outcomes } = await submitResults(env, actor, claim.claim_id, done.map((d) => d.result), usage, user.lang);
      accepted = outcomes.filter((o) => o.accepted).length;
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

const DIGEST_SYSTEM = (lang: Lang) =>
  `You write the owner's daily digest from the analyses of what they saved. Write in ${LANG_NAME[lang]}. Plain text, no images, no tags, no long quotes. Answer with JSON only:\n` +
  `{"summary": a few sentences on what was saved, at most 600 characters;\n` +
  ` "worth": [{"item_id": string, "line": one sentence with the conclusion, at most 160 characters}] — only items whose verdict is worth_deep_dive and that the owner has not marked (signal is null) and has not queued;\n` +
  ` "question": one question to sleep on, at most 160 characters}`;

/** Writes the daily digest for one user if it is due (after 21:00 in their time zone) and theirs to write. */
export async function digestForUser(env: Env, user: UserRow): Promise<boolean> {
  const actor = await builtinActor(env, user.id, "worker");
  if (!actor || user.role_digest !== actor.assistantId) return false;
  if (!(await digestDue(env, user))) return false;
  if ((await capLeft(env, user, "digest", num(env.DIGEST_PER_USER_PER_DAY, 1))) === 0) return false;
  const claim = await claimWork(env, actor, "digest", 1);
  if (!claim.claim_id) return false;
  await seen(env, actor);
  try {
    const day = claim.work[0].ref;
    const ctx = await getDigestContext(env, actor, day);
    const reply = await callModel(env, { timeoutMs: 25_000, maxTokens: 4000, system: DIGEST_SYSTEM(user.lang), content: JSON.stringify(ctx) });
    const x = reply ? (extractJson(reply.text) as any) : null;
    const summary = str(x?.summary, 600);
    const question = str(x?.question, 160);
    if (!reply || !summary || !question) {
      await releaseClaim(env, actor, claim.claim_id);
      return false;
    }
    const known = new Set(ctx.analyses.map((a) => a.item_id));
    const used = new Set<string>();
    const worth: { item_id: string; line: string }[] = [];
    for (const w of Array.isArray(x.worth) ? x.worth : []) {
      const line = str(w?.line, 160);
      if (!line || typeof w.item_id !== "string" || !known.has(w.item_id) || used.has(w.item_id)) continue;
      used.add(w.item_id);
      worth.push({ item_id: w.item_id, line });
    }
    const usage: UsageInput = { model: reply.model, input_tokens: reply.inputTokens, output_tokens: reply.outputTokens, calls: 1 };
    const { outcomes } = await submitResults(env, actor, claim.claim_id, [{ kind: "digest", day, summary, worth: worth.slice(0, 50), question }], usage, user.lang);
    return outcomes[0]?.accepted === true;
  } catch (e) {
    console.error("digest failed", e);
    await releaseClaim(env, actor, claim.claim_id).catch(() => {});
    return false;
  }
}

export { modelConfigured };
