// The model client of the built-in assistants: one request in the Anthropic Messages API
// format, with a hard time limit. Returns null on any failure; the caller then leaves the work
// for later (or for the core's defaults).
import { outbound, type Env } from "../env";

export interface ModelReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** The gateway answered 400 to the `effort` field and the request was sent again without it: do not ask for it again. */
  effortRefused?: boolean;
}

/**
 * What several requests for one piece of work may use together: until when (Date.now() milliseconds)
 * and how many HTTP requests. Each request takes from it, so a second ask does not get a fresh deadline.
 */
export interface ModelBudget {
  until: number;
  requests: number;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "url"; url: string } }
  | { type: "document"; source: { type: "url"; url: string } };

export interface ModelRequest {
  system: string;
  content: string | ContentBlock[];
  maxTokens: number;
  timeoutMs: number;
  /** Shared with the other requests for the same piece of work: the time limit is the least of `timeoutMs` and what is left of it. */
  budget?: ModelBudget;
  /** Do not send the `effort` field (an earlier request found that the gateway refuses it). */
  noEffort?: boolean;
  /** Told why there is no reply (for the log). Never contains content or the key. */
  onFailure?: (reason: string) => void;
  /**
   * Told what a reply that came back with nothing to use (a refusal, no content, an empty text) cost, when
   * the provider reported it: such a reply is paid for all the same. Not called when the reply carries no
   * usage (nothing is made up), and not for a reply that is returned (its cost is in the reply).
   */
  onUnusedReply?: (cost: { inputTokens: number; outputTokens: number; model: string }) => void;
}

export const DEFAULT_MODEL = "claude-haiku-5-5";

export function modelConfigured(env: Env): boolean {
  return Boolean(env.LLM_API_KEY);
}

/** What a call to the model cost, as the model said it. Only ever what the model said: nothing is made up for a call that got no answer. */
export interface ModelCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * The two things a call can come to, kept apart: `reply`, whether the answer can be used (it has text and is not a refusal),
 * and `cost`, whether the model answered at all and so was paid. An answer that carries its usage but no usable text (an empty
 * one, a refusal) has a cost and no reply. A call that got no answer (no credential, an error status, a timeout, a body that is
 * not an answer) has neither: `failure` says why.
 */
export interface ModelAnswer {
  reply: ModelReply | null;
  cost: ModelCost | null;
  failure?: string;
}

/** The tokens an answer says it used, or null when it says none (an error body, a gateway's own message). Cached parts count as input. */
function usageOf(data: any, model: string): ModelCost | null {
  const u = data?.usage;
  if (!u || typeof u !== "object") return null;
  // As before: a gateway may write a count as a string. Absent, or not a count, is "says nothing".
  const n = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
  const parts = [n(u.input_tokens), n(u.output_tokens), n(u.cache_creation_input_tokens), n(u.cache_read_input_tokens)];
  if (parts.every((p) => p === null)) return null;
  return {
    model: typeof data.model === "string" ? data.model : model,
    inputTokens: (parts[0] ?? 0) + (parts[2] ?? 0) + (parts[3] ?? 0),
    outputTokens: parts[1] ?? 0,
  };
}

export async function askModel(env: Env, req: ModelRequest): Promise<ModelAnswer> {
  const none = (failure: string): ModelAnswer => ({ reply: null, cost: null, failure });
  if (!env.LLM_API_KEY) return none("no credential");
  const base = (env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const timeoutMs = req.budget ? Math.min(req.timeoutMs, req.budget.until - Date.now()) : req.timeoutMs;
  if (timeoutMs <= 0) return none("time budget spent");
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  /** One HTTP request's worth of the budget. */
  const take = () => {
    if (!req.budget) return true;
    if (req.budget.requests <= 0) return false;
    req.budget.requests--;
    return true;
  };
  const send = (extra: Record<string, unknown>) =>
    outbound(env, `${base}/v1/messages`, {
      method: "POST",
      signal: abort.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": env.LLM_API_KEY!,
        authorization: `Bearer ${env.LLM_API_KEY}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.content }],
        ...extra,
      }),
    });
  try {
    // These are short, routine jobs: ask for low effort. A gateway that does not know the
    // field answers 400; then ask once more without it.
    let effortRefused = false;
    if (!take()) return none("request budget spent");
    let response = await send(req.noEffort ? {} : { output_config: { effort: "low" } });
    if (response.status === 400 && !req.noEffort) {
      await response.body?.cancel().catch(() => {});
      if (!take()) return none("request budget spent");
      effortRefused = true;
      response = await send({});
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const what = response.status === 401 || response.status === 403 ? "credential refused" : "model answered";
      return none(`${what} ${response.status}`);
    }
    const data = (await response.json()) as any;
    // The model answered: what it says it used is on record whatever came of the text.
    const cost = usageOf(data, model);
    if (data?.stop_reason === "refusal") return { reply: null, cost, failure: "model refused" };
    if (!Array.isArray(data?.content)) return { reply: null, cost, failure: "reply has no content" };
    const text = data.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (!text.trim()) return { reply: null, cost, failure: "reply is empty" };
    const used = cost ?? { model: typeof data.model === "string" ? data.model : model, inputTokens: 0, outputTokens: 0 };
    return {
      reply: { text, model: used.model, inputTokens: used.inputTokens, outputTokens: used.outputTokens, ...(effortRefused ? { effortRefused } : {}) },
      cost: used,
    };
  } catch (e) {
    return none(abort.signal.aborted ? `no reply within ${timeoutMs} ms` : `request failed: ${e instanceof Error ? e.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The usable reply, or null (the caller then leaves the work for later). For the jobs that do not account for an answer they cannot use. */
export async function callModel(env: Env, req: ModelRequest): Promise<ModelReply | null> {
  const answer = await askModel(env, req);
  if (!answer.reply) {
    req.onFailure?.(answer.failure ?? "no reply");
    // A reply with nothing to use still cost what the provider says it cost; one that reports nothing is not made up.
    if (answer.cost) req.onUnusedReply?.(answer.cost);
  }
  return answer.reply;
}

/** Finds the JSON value in a model reply: tolerates code fences and words around it. */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {}
  const starts = [cleaned.indexOf("{"), cleaned.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const close = cleaned[start] === "{" ? "}" : "]";
    for (let end = cleaned.lastIndexOf(close); end > start; end = cleaned.lastIndexOf(close, end - 1)) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {}
    }
  }
  return null;
}
