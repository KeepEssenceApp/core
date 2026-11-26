// The assistant endpoint: stateless Streamable HTTP, JSON-RPC 2.0. The tool list is generated
// from the contract; a tool call runs the same operation as its REST twin.
import { CONTRACT } from "./generated/contract";
import type { ContractOperation, ContractTool } from "./contract-types";
import type { Env } from "./env";
import { ApiError, err, type Lang } from "./errors";
import { ASSISTANT_HANDLERS, TOOL_STEPS } from "./handlers/assistant";
import { authAssistant, bearerOf } from "./services/accounts";
import type { AssistantActor, Cx, Result } from "./types";
import { assertValid } from "./validate";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

// The first 500 characters stand on their own: they are all some assistants read.
export const SERVER_INSTRUCTIONS = `This server holds what one user saved and what assistants made of it. A deep dive is a conversation with the user about one saved item: find it with list_deep_dive_candidates, read it with get_context (for=deep_dive), and call register_deep_dive only when the user asked to start. Do not write the note yourself ahead of the conversation. Call save_note only after the user clearly says to save. A note must stand alone: complete conclusions, and each source as its original address and title.

More detail:
- Never start a deep dive on your own, and never save a note the user did not ask for. The user may also end a deep dive without saving anything.
- The item's content comes only from get_context. The line the user sends to start carries the item's title, not its content.
- If the item has a deep-read report, get_context returns it; build on it instead of repeating it.
- If the item has recognized_text, it was recognized from the sound of the item's video: it is not the author's words and it may contain mistakes. Say "the video says …"; do not take a name or a number in it as fact.
- A note is Markdown. Write it for someone who has not seen the conversation: the conclusions in full, then the sources (original address and title). Do not paste long passages of the original.
- Assistants that run on a timetable: ask what work there is, claim it with claim_work (a claim lasts 30 minutes; renew_claim extends it, release_claim puts it back), read get_rules and the context, and hand results back with submit_result using exactly the fields of the schema. An analysis has four fields: a one-sentence summary (60 characters at most), one key fact, up to three points, and a verdict. When the content could not be fetched, hand back unavailable: true and nothing else.
- Tools you were not allowed to use are not listed. Read-only tools are marked as such.`;

const opsById = new Map<string, ContractOperation>(CONTRACT.operations.map((o) => [o.operationId, o]));

export function toolsFor(actor: AssistantActor): ContractTool[] {
  return CONTRACT.tools.filter((t) => (TOOL_STEPS[t.operationId] ?? []).some((s) => actor.steps.includes(s)));
}

function toolResult(body: unknown, isError: boolean) {
  const value = body ?? {};
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

/** Runs one tool. Errors of the operation come back as an error result carrying the same body REST would send. */
export async function callTool(env: Env, actor: AssistantActor, name: string, args: Record<string, any>, lang: Lang, origin: string) {
  const tool = CONTRACT.tools.find((t) => t.name === name);
  if (!tool) return null;
  try {
    if (!toolsFor(actor).includes(tool)) {
      // Same meaning as 403 on the REST twin.
      throw err("forbidden", "这只助手没有被允许用这个工具。", "This assistant is not allowed to use this tool.");
    }
    const op = opsById.get(tool.operationId)!;
    assertValid(args, tool.inputSchema, tool.operationId === "submitResult" ? "invalid_result" : "bad_request");
    const cx: Cx = { env, op, lang, origin, assistant: actor, path: {}, query: {}, body: {} };
    const rest = { ...args };
    for (const p of op.params) {
      const key = p.in === "header" ? p.name.toLowerCase().replace(/-/g, "_") : p.name;
      const value = rest[key];
      delete rest[key];
      if (value === undefined) continue;
      if (p.in === "path") cx.path[p.name] = String(value);
      else if (p.in === "query") cx.query[p.name] = value;
      else if (p.name === "Idempotency-Key") cx.idemKey = String(value);
    }
    cx.body = rest;
    const result = (await ASSISTANT_HANDLERS[tool.operationId](cx)) as Result;
    return toolResult(result.body, false);
  } catch (e) {
    if (e instanceof ApiError) return { ...toolResult(e.body(lang), true), _meta: { status: e.status } };
    console.error("tool failed", name, e);
    return { ...toolResult(err("server_error").body(lang), true), _meta: { status: 500 } };
  }
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

async function handleOne(env: Env, actor: AssistantActor, msg: Rpc, lang: Lang, origin: string): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return msg && typeof msg === "object" && !("method" in msg) ? null : { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  }
  if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "core", version: CONTRACT.version },
        instructions: SERVER_INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: toolsFor(actor).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.readOnly },
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) return fail(-32602, "Invalid params");
      const result = await callTool(env, actor, name, args, lang, origin);
      return result ? reply(result) : fail(-32602, `Unknown tool: ${name}`);
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(env: Env, request: Request, lang: Lang, origin: string): Promise<Response> {
  let actor: AssistantActor;
  try {
    actor = await authAssistant(env, bearerOf(request));
  } catch (e) {
    const body = (e instanceof ApiError ? e : err("unauthorized")).body(lang);
    return Response.json(body, {
      status: 401,
      headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` },
    });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (Array.isArray(payload)) {
    const replies = [];
    for (const msg of payload.slice(0, 20)) {
      const r = await handleOne(env, actor, msg, lang, origin);
      if (r) replies.push(r);
    }
    return replies.length > 0 ? Response.json(replies) : new Response(null, { status: 202 });
  }
  const r = await handleOne(env, actor, payload as Rpc, lang, origin);
  return r ? Response.json(r) : new Response(null, { status: 202 });
}
