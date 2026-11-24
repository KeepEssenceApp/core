import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import raw from "../contract/openapi.yaml?raw";
import { buildContract } from "../scripts/contract-lib.mjs";
import { buildApp, EXTRA_ROUTES, HANDLERS, honoPath } from "../src/app";
import { DEFAULT_TEXTS } from "../src/errors";
import { CONTRACT } from "../src/generated/contract";
import { SERVER_INSTRUCTIONS } from "../src/mcp";
import { call, makeEnv } from "./helpers";

const doc = parse(raw);

function contractRoutes(): string[] {
  const out: string[] = [];
  for (const [path, item] of Object.entries<any>(doc.paths)) {
    for (const method of ["get", "put", "post", "patch", "delete"]) if (item[method]) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out.sort();
}

describe("C2 routes: the router and the contract list the same routes", () => {
  const registered = buildApp()
    .routes.map((r) => `${r.method} ${r.path.replace(/:(\w+)\{[^}]*svg\}/g, "{$1}.svg").replace(/:(\w+)/g, "{$1}")}`)
    .sort();
  const extra = EXTRA_ROUTES.map((r) => `${r.method} ${r.path}`);

  it("C2 routes: every route of the contract is implemented by the core", () => {
    const missing = contractRoutes().filter((r) => !registered.includes(r));
    expect(missing).toEqual([]);
  });

  it("C2 routes: every route of the core is in the contract, apart from the listed operator and signed-address routes", () => {
    const unknown = registered.filter((r) => !contractRoutes().includes(r) && !extra.includes(r));
    expect(unknown).toEqual([]);
    // The exceptions really exist and are only uploads/downloads and /admin.
    for (const e of extra) expect(registered).toContain(e);
    expect(EXTRA_ROUTES.every((r) => r.path.startsWith("/admin/") || r.path.startsWith("/v1/uploads/") || r.path.startsWith("/v1/downloads/"))).toBe(true);
  });

  it("C2 routes: there is exactly one handler per operationId", () => {
    const ids = CONTRACT.operations.map((o) => o.operationId).sort();
    expect(Object.keys(HANDLERS).sort()).toEqual(ids);
    expect(honoPath("/c/{secret}.svg")).toBe("/c/:secret{[^/]+\\.svg}");
  });

  it("C2 routes: an unknown path answers 404 and a known path with another method answers 405", async () => {
    const env = makeEnv();
    expect((await call(env, "GET", "/v1/nothing-here")).status).toBe(404);
    const r = await call(env, "GET", "/mcp");
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});

describe("C3 tools: the tool list is generated from the contract", () => {
  it("C3 tools: the generated file is up to date with contract/openapi.yaml", () => {
    expect(JSON.parse(JSON.stringify(buildContract(doc)))).toEqual(CONTRACT);
  });

  it("C3 tools: one tool per x-mcp-tool operation, same input, read-only marked", () => {
    const marked: { tool: string; readOnly: boolean; id: string }[] = [];
    for (const item of Object.values<any>(doc.paths)) {
      for (const op of Object.values<any>(item)) {
        if (op && op["x-mcp-tool"]) marked.push({ tool: op["x-mcp-tool"], readOnly: op["x-mcp-readonly"] === true, id: op.operationId });
      }
    }
    expect(CONTRACT.tools.map((t) => t.name).sort()).toEqual(marked.map((m) => m.tool).sort());
    for (const m of marked) {
      const tool = CONTRACT.tools.find((t) => t.name === m.tool)!;
      expect(tool.operationId).toBe(m.id);
      expect(tool.readOnly).toBe(m.readOnly);
      expect(tool.inputSchema.type).toBe("object");
    }
    const submit = CONTRACT.tools.find((t) => t.name === "submit_result")!;
    expect(Object.keys(submit.inputSchema.properties).sort()).toEqual(["id", "idempotency_key", "results", "usage"]);
    expect(submit.inputSchema.required).toEqual(["id", "idempotency_key", "results"]);
    // The work question stays a plain request: it is not a tool.
    expect(CONTRACT.tools.find((t) => t.operationId === "getWork")).toBeUndefined();
  });
});

describe("C4 names: no product name and no assistant brand in contract-facing text", () => {
  const banned = /keep\s*essence|allkeep|claude|chatgpt|openai|gemini|anthropic|\bmuse\b|\bscout\b/i;

  it("C4 names: the contract itself is clean", () => {
    expect(raw).not.toMatch(banned);
  });

  it("C4 names: what the core says to clients and assistants is clean", async () => {
    expect(JSON.stringify(CONTRACT)).not.toMatch(banned);
    expect(SERVER_INSTRUCTIONS).not.toMatch(banned);
    expect(JSON.stringify(DEFAULT_TEXTS)).not.toMatch(banned);
    const meta = await call(makeEnv(), "GET", "/v1/meta");
    expect(meta.text).not.toMatch(banned);
  });
});

describe("meta: limits and shared rules come from the contract", () => {
  it("meta: GET /v1/meta serves x-limits and x-shared-rules unchanged, without a credential", async () => {
    const r = await call(makeEnv(), "GET", "/v1/meta");
    expect(r.status).toBe(200);
    expect(r.json.contract_version).toBe(doc.info.version);
    expect(r.json.limits).toEqual(doc["x-limits"]);
    expect(r.json.shared_rules).toEqual(doc["x-shared-rules"]);
  });
});
