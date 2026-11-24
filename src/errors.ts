// One error shape for the whole core: { "error": { "code", "message" } }.
// `code` is one of the contract's x-error-codes; `message` is written for the user in zh or en.
export type Lang = "zh" | "en";
export type Text = { zh: string; en: string };

export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "gone"
  | "too_large"
  | "unsupported_type"
  | "rate_limited"
  | "not_invited"
  | "last_manager"
  | "claim_lost"
  | "invalid_result"
  | "idempotency_key_required"
  | "server_error";

export const DEFAULT_TEXTS: Record<ErrorCode, Text> = {
  bad_request: { zh: "请求格式不对，或有字段超出范围。", en: "The request is malformed or a field is out of range." },
  unauthorized: { zh: "没有凭据，或凭据无效、已撤销、已过期。", en: "No credential, or it is unknown, revoked or expired." },
  forbidden: { zh: "这个凭据的权限不允许这样做。", en: "This credential's permission does not allow this." },
  not_found: { zh: "没有这个东西。", en: "There is no such thing." },
  conflict: { zh: "这个请求和当前状态冲突。", en: "The request conflicts with the current state." },
  gone: { zh: "它已经不在了。", en: "It is no longer available." },
  too_large: { zh: "文件超过了允许的大小。", en: "The upload is larger than allowed." },
  unsupported_type: { zh: "文件头和允许的类型不符。", en: "The file header does not match an allowed type." },
  rate_limited: { zh: "请求太多，请稍后再试。", en: "Too many requests. Try again later." },
  not_invited: { zh: "这个邮箱不在邀请名单里。", en: "This email is not on the invitation list." },
  last_manager: {
    zh: "最后一台管理档的设备不能降档，也不能撤销。",
    en: "The last device with the manage tier cannot be lowered or revoked.",
  },
  claim_lost: { zh: "认领已过期，这份活已被别的助手认领。", en: "The claim expired and the work was claimed by someone else." },
  invalid_result: { zh: "交回的结果不符合要求的字段。", en: "A submitted result does not follow the required fields." },
  idempotency_key_required: { zh: "缺少 Idempotency-Key 请求头。", en: "The Idempotency-Key header is missing." },
  server_error: { zh: "核心出了问题。", en: "Something went wrong in the core." },
};

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  gone: 410,
  too_large: 413,
  unsupported_type: 415,
  rate_limited: 429,
  not_invited: 404,
  last_manager: 409,
  claim_lost: 409,
  invalid_result: 400,
  idempotency_key_required: 400,
  server_error: 500,
};

export class ApiError extends Error {
  readonly status: number;
  headers: Record<string, string> = {};
  constructor(
    readonly code: ErrorCode,
    readonly detail?: Text,
    status?: number,
  ) {
    super(detail?.en ?? DEFAULT_TEXTS[code].en);
    this.status = status ?? STATUS[code];
  }
  text(lang: Lang): string {
    return (this.detail ?? DEFAULT_TEXTS[this.code])[lang];
  }
  body(lang: Lang): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.text(lang) } };
  }
}

export function err(code: ErrorCode, zh?: string, en?: string): ApiError {
  return new ApiError(code, zh !== undefined && en !== undefined ? { zh, en } : undefined);
}

export function pickLang(header: string | null | undefined, fallback: Lang = "en"): Lang {
  if (!header) return fallback;
  for (const part of header.split(",")) {
    const tag = part.trim().toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return fallback;
}
