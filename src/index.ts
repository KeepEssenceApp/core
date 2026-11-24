// Entry point of the Worker: HTTPS only, CORS, routing to the API or on to the web app, cron.
import { buildApp, errorResponse } from "./app";
import { runHourly, runMinute } from "./cron";
import type { Env } from "./env";
import { err, pickLang } from "./errors";

const app = buildApp();

/** Paths the core answers itself. Everything else belongs to the web app. */
export function isCorePath(path: string): boolean {
  return (
    path.startsWith("/v1/") ||
    path === "/v1" ||
    path.startsWith("/oauth/") ||
    path.startsWith("/.well-known/oauth-") ||
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path.startsWith("/admin/") ||
    path.startsWith("/c/")
  );
}

function isLocal(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/** Browser extensions and the web origin may call the API; the OAuth and assistant endpoints are open to any origin. */
function corsHeaders(env: Env, request: Request, path: string): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const open = path.startsWith("/v1/uploads/") || path.startsWith("/v1/downloads/") || path.startsWith("/oauth/") || path.startsWith("/.well-known/") || path === "/mcp" || path.startsWith("/c/");
  const listed = [env.APP_ORIGIN, ...(env.ALLOWED_ORIGINS ?? "").split(",")].map((o) => (o ?? "").trim()).filter(Boolean);
  let allowed = open || listed.includes(origin) || /^(chrome-extension|moz-extension|safari-web-extension):\/\//.test(origin);
  if (!allowed && env.ALLOW_HTTP === "1") {
    try {
      allowed = isLocal(new URL(origin).hostname);
    } catch {}
  }
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": "Authorization, Content-Type, Idempotency-Key, Accept-Language, Accept, MCP-Protocol-Version",
    "access-control-expose-headers": "Retry-After, WWW-Authenticate, Idempotent-Replay",
    "access-control-max-age": "86400",
  };
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const lang = pickLang(request.headers.get("accept-language"));
  // HTTPS only. Plain http is redirected (reads) or refused (writes); local development may opt out.
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  if (proto === "http" && !(env.ALLOW_HTTP === "1" && isLocal(url.hostname))) {
    if (request.method === "GET" || request.method === "HEAD") {
      url.protocol = "https:";
      return new Response(null, { status: 308, headers: { location: url.toString() } });
    }
    return Response.json(err("bad_request", "只接受 HTTPS。", "HTTPS only.").body(lang), { status: 400 });
  }
  if (!isCorePath(url.pathname)) {
    // A share from the phone's share sheet normally stops in the web app's service worker.
    // When that worker is not active yet the POST arrives here; send the browser to the page,
    // which says the share could not be read, instead of answering an error.
    if (request.method === "POST" && new URL(request.url).pathname === "/share") {
      return new Response(null, { status: 303, headers: { location: "/share" } });
    }
    if (env.WEB) return env.WEB.fetch(request);
    return Response.json(err("not_found").body(lang), { status: 404 });
  }
  const cors = corsHeaders(env, request, url.pathname);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  let response: Response;
  try {
    response = await app.fetch(request, env, ctx);
  } catch (e) {
    response = errorResponse(e, lang);
  }
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
  return out;
}

export default {
  fetch: handle,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(event.cron === "0 * * * *" ? runHourly(env) : runMinute(env));
  },
} satisfies ExportedHandler<Env>;

export { app };
