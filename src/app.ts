// The router. Every route comes from the generated contract: the path, who may call it
// (tier or assistant), its parameters and its body schema. A handler exists per operationId.
import { Hono } from "hono";
import { CONTRACT } from "./generated/contract";
import type { ContractOperation } from "./contract-types";
import { LIMITS, type Env } from "./env";
import { ApiError, err, pickLang, type Lang } from "./errors";
import { handleDownload, handleUpload, completeUpload, getAsset, requestUpload } from "./handlers/assets";
import * as account from "./handlers/account";
import * as feedback from "./handlers/feedback";
import { ASSISTANT_HANDLERS } from "./handlers/assistant";
import * as devices from "./handlers/devices";
import * as items from "./handlers/items";
import * as oauth from "./handlers/oauth";
import * as reading from "./handlers/reading";
import * as settings from "./handlers/settings";
import { ADMIN_ROUTES, runAdmin } from "./handlers/admin";
import { getMeta, requestLoginCode, signIn } from "./handlers/signin";
import { handleMcp } from "./mcp";
import { authAssistant, authDevice, bearerOf, tierAllows } from "./services/accounts";
import type { Cx, Handler, Result } from "./types";
import { assertValid, coerce } from "./validate";

export const HANDLERS: Record<string, Handler> = {
  getMeta,
  requestLoginCode,
  signIn,
  createDeviceCode: devices.createDeviceCode,
  pollDeviceCode: devices.pollDeviceCode,
  getDeviceCodeRequest: devices.getDeviceCodeRequest,
  approveDeviceCode: devices.approveDeviceCode,
  denyDeviceCode: devices.denyDeviceCode,
  listDevices: devices.listDevices,
  getThisDevice: devices.getThisDevice,
  signOutThisDevice: devices.signOutThisDevice,
  registerPush: devices.registerPush,
  unregisterPush: devices.unregisterPush,
  updateDevice: devices.updateDevice,
  revokeDevice: devices.revokeDevice,
  getPushKey: devices.getPushKey,
  saveItem: items.saveItem,
  listItems: items.listItems,
  searchItems: items.searchItems,
  getItem: items.getItem,
  updateItem: items.updateItem,
  deleteItem: items.deleteItem,
  pinItem: items.pinItem,
  unpinItem: items.unpinItem,
  setSignal: items.setSignal,
  clearSignal: items.clearSignal,
  listDigests: reading.listDigests,
  getDigest: reading.getDigest,
  markDigestRead: reading.markDigestRead,
  listQueue: reading.listQueue,
  addToQueue: reading.addToQueue,
  removeFromQueue: reading.removeFromQueue,
  startDeepDive: reading.startDeepDive,
  listNotes: reading.listNotes,
  pasteNote: reading.pasteNote,
  getNote: reading.getNote,
  requestUpload,
  completeUpload,
  getAsset,
  getStatus: reading.getStatus,
  getCalendar: reading.getCalendar,
  getStats: reading.getStats,
  getUsage: reading.getUsage,
  getSettings: settings.getSettings,
  updateSettings: settings.updateSettings,
  rotateCalendarImage: settings.rotateCalendarImage,
  exportData: account.exportData,
  deleteAccount: account.deleteOwnAccount,
  sendFeedback: feedback.sendFeedback,
  listAssistants: settings.listAssistantsHandler,
  updateAssistant: settings.updateAssistant,
  revokeAssistant: settings.revokeAssistantHandler,
  getAuthorizationRequest: oauth.getAuthorizationRequest,
  decideAuthorizationRequest: oauth.decideAuthorizationRequest,
  ...ASSISTANT_HANDLERS,
  getAuthorizationServerMetadata: oauth.getAuthorizationServerMetadata,
  getProtectedResourceMetadata: oauth.getProtectedResourceMetadata,
  registerClient: oauth.registerClient,
  authorize: oauth.authorize,
  token: oauth.token,
  revoke: oauth.revoke,
  // The assistant endpoint authenticates itself (its 401 carries a WWW-Authenticate header).
  assistantEndpoint: async (cx) => handleMcp(cx.env, cx.request!, cx.lang, cx.origin),
  getCalendarImage: async (cx) => settings.calendarImage(cx.env, cx.path.secret.replace(/\.svg$/, ""), new URL(cx.request!.url).searchParams),
};

/** Checks that answer with a more exact status than the general "bad request" of schema validation. */
const PRECHECKS: Record<string, (body: Record<string, any>) => void> = {
  requestUpload(body) {
    if (typeof body.bytes === "number" && body.bytes > LIMITS.asset_max_bytes) throw err("too_large");
    if (typeof body.content_type === "string" && !CONTRACT.enums.AssetType.includes(body.content_type)) throw err("unsupported_type");
  },
};

/** Routes the core serves that are not operations of the contract. Kept short and listed in one place. */
export const EXTRA_ROUTES: { method: string; path: string; why: string }[] = [
  { method: "PUT", path: "/v1/uploads/{id}", why: "the signed upload address that POST /v1/assets hands out" },
  { method: "GET", path: "/v1/downloads/{id}", why: "the signed download address that GET /v1/assets/{id} hands out" },
  // The operator (admin) interface: docs/admin-api.md. One list, in handlers/admin.ts.
  ...ADMIN_ROUTES.map((r) => ({ method: r.method, path: r.path, why: r.why })),
];

/** `/v1/items/{id}` → `/v1/items/:id`; `/c/{secret}.svg` → `/c/:secret{[^/]+\\.svg}`. */
export function honoPath(path: string): string {
  return path.replace(/\{(\w+)\}\.svg/g, ":$1{[^/]+\\.svg}").replace(/\{(\w+)\}/g, ":$1");
}

function respond(result: Result | Response): Response {
  if (result instanceof Response) return result;
  if (result.body === undefined) return new Response(null, { status: result.status, headers: result.headers });
  return Response.json(result.body, { status: result.status, headers: result.headers });
}

export function errorResponse(e: unknown, lang: Lang): Response {
  if (e instanceof ApiError) return Response.json(e.body(lang), { status: e.status, headers: e.headers });
  console.error("unhandled", e);
  return Response.json(err("server_error").body(lang), { status: 500 });
}

async function readBody(op: ContractOperation, request: Request): Promise<Record<string, any>> {
  if (!op.bodyType) return {};
  const text = new TextDecoder().decode(await request.arrayBuffer());
  if (!text.trim()) {
    if (op.bodyRequired) throw err("bad_request", "缺少请求内容。", "The request body is missing.");
    return {};
  }
  if (op.bodyType === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(text));
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw err("bad_request", "请求内容不是合法的 JSON。", "The request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw err("bad_request", "请求内容应为 JSON 对象。", "The request body must be a JSON object.");
  return body as Record<string, any>;
}

async function run(op: ContractOperation, handler: Handler, env: Env, request: Request, pathParams: Record<string, string>, exec?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const header = request.headers.get("accept-language");
  let lang = pickLang(header);
  try {
    const cx: Cx = {
      env,
      op,
      lang,
      origin: env.PUBLIC_ORIGIN || url.origin,
      exec,
      request,
      bearer: bearerOf(request),
      path: {},
      query: {},
      body: {},
    };
    // Who is calling, and may they.
    if (op.auth === "device") {
      const { device, user } = await authDevice(env, cx.bearer ?? null);
      cx.device = device;
      cx.user = user;
      if (!header) cx.lang = lang = user.lang;
      if (!tierAllows(device.tier, op.tier ?? "manage")) throw err("forbidden");
    } else if (op.auth === "assistant" && op.operationId !== "assistantEndpoint") {
      cx.assistant = await authAssistant(env, cx.bearer ?? null);
    }
    // Parameters, checked against the contract.
    for (const p of op.params) {
      if (p.in === "path") {
        const value = decodeURIComponent(pathParams[p.name] ?? "");
        assertValid(value, p.schema, "bad_request", p.name);
        cx.path[p.name] = value;
      } else if (p.in === "query") {
        const raw = url.searchParams.get(p.name);
        if (raw === null) {
          if (p.required) throw err("bad_request", `缺少参数 ${p.name}。`, `The parameter ${p.name} is missing.`);
          if (p.schema.default !== undefined) cx.query[p.name] = p.schema.default;
          continue;
        }
        const value = coerce(raw, p.schema);
        assertValid(value, p.schema, "bad_request", p.name);
        cx.query[p.name] = value;
      } else if (p.name === "Idempotency-Key") {
        cx.idemKey = request.headers.get("idempotency-key") ?? undefined;
        if (!cx.idemKey) throw err("idempotency_key_required");
      }
    }
    // The assistant endpoint reads its own body: JSON-RPC has its own error shape.
    if (op.operationId !== "assistantEndpoint") cx.body = await readBody(op, request);
    PRECHECKS[op.operationId]?.(cx.body);
    if (op.body && op.operationId !== "assistantEndpoint") assertValid(cx.body, op.body, op.operationId === "submitResult" ? "invalid_result" : "bad_request");
    return respond(await handler(cx));
  } catch (e) {
    return errorResponse(e, lang);
  }
}

export function buildApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  for (const op of CONTRACT.operations) {
    const handler = HANDLERS[op.operationId];
    if (!handler) continue; // the route test fails loudly when a handler is missing
    app.on(op.method, honoPath(op.path), (c) => {
      let exec: ExecutionContext | undefined;
      try {
        exec = c.executionCtx as ExecutionContext;
      } catch {
        exec = undefined;
      }
      return run(op, handler, c.env, c.req.raw, c.req.param() as Record<string, string>, exec);
    });
  }
  const guarded = (fn: (env: Env, request: Request, id: string) => Promise<Response>) => async (c: any) => {
    try {
      return await fn(c.env, c.req.raw, c.req.param("id") ?? "");
    } catch (e) {
      // Do not leave an unread upload hanging.
      if (c.req.raw.body && !c.req.raw.body.locked) await c.req.raw.body.cancel().catch(() => {});
      return errorResponse(e, pickLang(c.req.header("accept-language")));
    }
  };
  app.put("/v1/uploads/:id", guarded(handleUpload));
  app.get("/v1/downloads/:id", guarded(handleDownload));
  for (const route of ADMIN_ROUTES) {
    app.on(route.method, honoPath(route.path), async (c) => {
      try {
        return await runAdmin(route, c.env, c.req.raw, c.req.param() as Record<string, string>);
      } catch (e) {
        return errorResponse(e, pickLang(c.req.header("accept-language")));
      }
    });
  }

  const known = CONTRACT.operations.map((op) => ({ method: op.method, match: new RegExp("^" + op.path.replace(/\{\w+\}/g, "[^/]+").replace(/\./g, "\\.") + "$") }));
  app.notFound((c) => {
    const lang = pickLang(c.req.header("accept-language"));
    const path = new URL(c.req.url).pathname;
    const allowed = known.filter((k) => k.match.test(path)).map((k) => k.method);
    if (allowed.length > 0) {
      // The path exists, the method does not (for example GET on the assistant endpoint).
      return Response.json(err("bad_request", "这个地址不支持这种请求方法。", "This address does not support this method.").body(lang), {
        status: 405,
        headers: { allow: [...new Set(allowed)].join(", ") },
      });
    }
    return Response.json(err("not_found").body(lang), { status: 404 });
  });
  app.onError((e, c) => errorResponse(e, pickLang(c.req.header("accept-language"))));
  return app;
}
