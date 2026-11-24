// The two built-in assistants. They have their own identities and steps, and they work through
// the same service functions as any connected assistant: ask for work, claim, read the rules and
// the context, hand results back. Nothing here writes to the database directly.
import { now } from "./clock";
import { LIMITS, num, type Env } from "./env";
import type { Lang } from "./errors";
import { builtinActor, getUser } from "./services/accounts";
import { callModel, extractJson, modelConfigured, type ContentBlock } from "./services/model";
import { digestDue } from "./services/digests";
import { capLeft, claimWork, getContext, getDigestContext, getRules, releaseClaim, submitResults, type UsageInput } from "./services/work";
import type { AssistantActor, UserRow } from "./types";
import { truncate } from "./util";

const LANG_NAME: Record<Lang, string> = { zh: "简体中文", en: "English" };
const VERDICTS = ["worth_deep_dive", "good_to_know", "skippable"];

async function seen(env: Env, actor: AssistantActor): Promise<void> {
  await env.DB.prepare("UPDATE assistants SET last_seen_at = ? WHERE id = ? AND user_id = ?").bind(now(), actor.assistantId, actor.userId).run();
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? truncate(value.replace(/\s+/g, " ").trim(), max) : undefined;
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
    const reply = await callModel(env, {
      timeoutMs: 10_000,
      maxTokens: 1500,
      system:
        "You sort saved items. For each item decide which assistant analyses it and how many days it is kept. " +
        "You see only the title, the site and the opening of each item. Follow the user's rules when they apply; otherwise leave a field out. " +
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
      if (x && rules.expiry_options.includes(x.expiry_days)) result.expiry_days = x.expiry_days;
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
  `{"summary": one sentence, at most ${LIMITS.analysis_summary_max_chars} characters, saying what the item is about;\n` +
  ` "key_fact": one line that fits the kind of content (article: author and length; video: duration; repository: language and stars; screenshot: the main thing in it; post: author and platform; text: word count; file: format and pages);\n` +
  ` "points": up to ${LIMITS.analysis_points_max} short sentences with the substance;\n` +
  ` "verdict": "worth_deep_dive" | "good_to_know" | "skippable";\n` +
  ` "related_hint": optional, one sentence naming an earlier item, digest or note of the owner (from "related") that this connects to. Leave it out if nothing connects.}\n` +
  `Judge by the owner's rules if they say what matters. Do not copy long passages. If you cannot read the content at all, answer {"unavailable": true}.`;

async function analyseOne(env: Env, actor: AssistantActor, itemId: string, rules: Awaited<ReturnType<typeof getRules>>, origin: string) {
  const ctx = await getContext(env, actor, itemId, "analysis", origin);
  if (ctx.item.content_unavailable) return { result: { kind: "analysis", item_id: itemId, unavailable: true }, usage: null };
  const facts = {
    kind: ctx.item.kind,
    title: ctx.item.title,
    site: ctx.item.site,
    saved_at: ctx.item.saved_at,
    rules: rules.rules,
    related: ctx.related,
    content: truncate(ctx.item.body ?? "", 24_000),
  };
  let content: string | ContentBlock[] = JSON.stringify(facts);
  if (!ctx.item.body && ctx.item.asset_url && /^https:\/\//.test(ctx.item.asset_url)) {
    // An image or a PDF with no text: let the model look at the file itself through its short-lived address.
    const block: ContentBlock = ctx.item.kind === "image" ? { type: "image", source: { type: "url", url: ctx.item.asset_url } } : { type: "document", source: { type: "url", url: ctx.item.asset_url } };
    content = [block, { type: "text", text: JSON.stringify(facts) }];
  } else if (!ctx.item.body) {
    return { result: { kind: "analysis", item_id: itemId, unavailable: true }, usage: null };
  }
  const reply = await callModel(env, { timeoutMs: 25_000, maxTokens: 2000, system: ANALYSIS_SYSTEM(rules.lang as Lang), content });
  if (!reply) return null;
  const usage = { input: reply.inputTokens, output: reply.outputTokens, model: reply.model };
  const x = extractJson(reply.text) as any;
  if (!x || typeof x !== "object") return null;
  if (x.unavailable === true) return { result: { kind: "analysis", item_id: itemId, unavailable: true }, usage };
  const summary = str(x.summary, LIMITS.analysis_summary_max_chars);
  if (!summary || !VERDICTS.includes(x.verdict)) return null;
  const result: Record<string, unknown> = {
    kind: "analysis",
    item_id: itemId,
    summary,
    verdict: x.verdict,
    points: (Array.isArray(x.points) ? x.points : []).map((p: unknown) => str(p, 120)).filter(Boolean).slice(0, LIMITS.analysis_points_max),
  };
  const keyFact = str(x.key_fact, 120);
  if (keyFact) result.key_fact = keyFact;
  const hint = str(x.related_hint, 120);
  if (hint) result.related_hint = hint;
  return { result, usage };
}

/** One round of analyses for one user, within the daily cap. */
export async function analyseForUser(env: Env, userId: string, origin: string): Promise<number> {
  const actor = await builtinActor(env, userId, "worker");
  if (!actor) return 0;
  const user = await getUser(env, userId);
  const left = await capLeft(env, user, "analysis", num(env.ANALYSIS_PER_USER_PER_DAY, 200));
  if (left === 0) return 0;
  const claim = await claimWork(env, actor, "analysis", Math.min(num(env.ANALYSIS_BATCH, 2), left));
  if (!claim.claim_id) return 0;
  await seen(env, actor);
  try {
    const rules = await getRules(env, actor, "analysis");
    const done = (await Promise.all(claim.work.map((w) => analyseOne(env, actor, w.ref, rules, origin).catch(() => null)))).filter((d) => d !== null);
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
