// A small validator for the JSON Schema subset the contract uses. Request bodies and
// parameters are checked against the schemas generated from the contract, so the rules
// live in one place.
import { ApiError, type ErrorCode, type Text } from "./errors";
import type { Schema } from "./contract-types";
import { charLen } from "./util";

export interface Problem {
  path: string;
  text: Text;
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const t = typeOf(value);
  return t === type || (type === "number" && t === "integer");
}

function problem(path: string, zh: string, en: string): Problem {
  return { path, text: { zh, en } };
}

export function check(value: unknown, schema: Schema, path = ""): Problem | null {
  const name = path || "body";
  if (schema.oneOf) {
    const variants: Schema[] = schema.oneOf;
    const nonNull = variants.filter((v) => v.type !== "null");
    if (value === null && nonNull.length < variants.length) return null;
    const disc = schema["x-discriminator"] as { property: string; map: Record<string, number> } | undefined;
    if (disc) {
      if (typeOf(value) !== "object") return problem(name, "应为对象", "must be an object");
      const tag = (value as any)[disc.property];
      const index = typeof tag === "string" ? disc.map[tag] : undefined;
      if (index === undefined || index < 0) {
        const allowed = Object.keys(disc.map).join(", ");
        return problem(`${name}.${disc.property}`, `只能是 ${allowed} 之一`, `must be one of ${allowed}`);
      }
      return check(value, variants[index], path);
    }
    let first: Problem | null = null;
    for (const v of nonNull) {
      const p = check(value, v, path);
      if (!p) return null;
      first ??= p;
    }
    return first;
  }
  if (schema.allOf) {
    for (const part of schema.allOf as Schema[]) {
      const p = check(value, part, path);
      if (p) return p;
    }
    return null;
  }
  if ("const" in schema && value !== schema.const) {
    return problem(name, `只能是 ${schema.const}`, `must be ${schema.const}`);
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      const want = types.join(" | ");
      return problem(name, `类型应为 ${want}`, `must be of type ${want}`);
    }
  }
  if (value === null) return null;
  if (schema.enum && !schema.enum.includes(value)) {
    const allowed = schema.enum.filter((v: unknown) => v !== null).join(", ");
    return problem(name, `只能是 ${allowed} 之一`, `must be one of ${allowed}`);
  }
  if (typeof value === "string") {
    const n = charLen(value);
    if (schema.maxLength !== undefined && n > schema.maxLength)
      return problem(name, `最多 ${schema.maxLength} 个字，现在是 ${n} 个`, `must be at most ${schema.maxLength} characters, got ${n}`);
    if (schema.minLength !== undefined && n < schema.minLength)
      return problem(name, `至少 ${schema.minLength} 个字`, `must be at least ${schema.minLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return problem(name, "格式不对", "has the wrong format");
    if (schema.format === "uri" && !/^[a-z][a-z0-9+.-]*:\S+$/i.test(value)) return problem(name, "应为网址", "must be a URI");
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
      return problem(name, "应为邮箱地址", "must be an email address");
  }
  if (typeof value === "number") {
    if (schema.maximum !== undefined && value > schema.maximum)
      return problem(name, `不能大于 ${schema.maximum}`, `must be at most ${schema.maximum}`);
    if (schema.minimum !== undefined && value < schema.minimum)
      return problem(name, `不能小于 ${schema.minimum}`, `must be at least ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return problem(name, `最多 ${schema.maxItems} 条，现在是 ${value.length} 条`, `must have at most ${schema.maxItems} entries, got ${value.length}`);
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return problem(name, `至少 ${schema.minItems} 条`, `must have at least ${schema.minItems} entries`);
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const p = check(value[i], schema.items, `${path}[${i}]`);
        if (p) return p;
      }
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const key of (schema.required ?? []) as string[]) {
      if (obj[key] === undefined) return problem(path ? `${path}.${key}` : key, "必填", "is required");
    }
    for (const [key, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = props[key];
      const where = path ? `${path}.${key}` : key;
      if (!sub) {
        if (schema.additionalProperties === false) return problem(where, "不接受这个字段", "is not an accepted field");
        continue;
      }
      const p = check(v, sub, where);
      if (p) return p;
    }
  }
  return null;
}

export function assertValid(value: unknown, schema: Schema, code: ErrorCode = "bad_request", prefix = ""): void {
  const p = check(value, schema, prefix);
  if (p) throw new ApiError(code, { zh: `字段 ${p.path}：${p.text.zh}。`, en: `Field ${p.path}: ${p.text.en}.` });
}

/** Turns a query-string value into the type its schema asks for. */
export function coerce(raw: string, schema: Schema): unknown {
  const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("integer") || types.includes("number")) {
    const n = Number(raw);
    return raw.trim() !== "" && Number.isFinite(n) ? n : raw;
  }
  if (types.includes("boolean")) return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
}
