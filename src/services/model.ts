// The model client of the built-in assistants: one request in the Anthropic Messages API
// format, with a hard time limit. Returns null on any failure; the caller then leaves the work
// for later (or for the core's defaults).
import { outbound, type Env } from "../env";

export interface ModelReply {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
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
  /** Told why there is no reply (for the log). Never contains content or the key. */
  onFailure?: (reason: string) => void;
}

export const DEFAULT_MODEL = "claude-haiku-5-5";

export function modelConfigured(env: Env): boolean {
  return Boolean(env.LLM_API_KEY);
}

export async function callModel(env: Env, req: ModelRequest): Promise<ModelReply | null> {
  const fail = (reason: string) => {
    req.onFailure?.(reason);
    return null;
  };
  if (!env.LLM_API_KEY) return fail("no credential");
  const base = (env.LLM_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const model = env.LLM_MODEL || DEFAULT_MODEL;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), req.timeoutMs);
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
    let response = await send({ output_config: { effort: "low" } });
    if (response.status === 400) {
      await response.body?.cancel().catch(() => {});
      response = await send({});
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const what = response.status === 401 || response.status === 403 ? "credential refused" : "model answered";
      return fail(`${what} ${response.status}`);
    }
    const data = (await response.json()) as any;
    if (data?.stop_reason === "refusal") return fail("model refused");
    if (!Array.isArray(data?.content)) return fail("reply has no content");
    const text = data.content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (!text.trim()) return fail("reply is empty");
    return {
      text,
      model: typeof data.model === "string" ? data.model : model,
      // Gateways that cache prompts report the cached part separately; count all of it as input.
      inputTokens:
        (Number(data.usage?.input_tokens) || 0) +
        (Number(data.usage?.cache_creation_input_tokens) || 0) +
        (Number(data.usage?.cache_read_input_tokens) || 0),
      outputTokens: Number(data.usage?.output_tokens) || 0,
    };
  } catch (e) {
    return fail(abort.signal.aborted ? `no reply within ${req.timeoutMs} ms` : `request failed: ${e instanceof Error ? e.name : "error"}`);
  } finally {
    clearTimeout(timer);
  }
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
