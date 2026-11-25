import { CONTRACT } from "./generated/contract";

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  WEB?: Fetcher;

  APP_ORIGIN?: string;
  PUBLIC_ORIGIN?: string;
  ALLOWED_ORIGINS?: string;
  ALLOW_HTTP?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  TRIAGE_BATCH?: string;
  TRIAGE_USERS_PER_RUN?: string;
  ANALYSIS_BATCH?: string;
  ANALYSIS_USERS_PER_RUN?: string;
  ANALYSIS_PER_USER_PER_DAY?: string;
  DIGEST_PER_USER_PER_DAY?: string;
  BODY_MAX_CHARS?: string;
  SAVE_RATE_PER_MINUTE?: string;
  PUBLIC_RATE_PER_10_MIN?: string;
  DELETE_COPIES_ON_USER_DELETE?: string;
  ARCHIVE_RETENTION_DAYS?: string;
  PAGE_FETCH_TIMEOUT_MS?: string;
  /** Optional: what GET /admin/overview reports as the version (defaults to the package version). */
  CORE_VERSION?: string;

  LLM_API_KEY?: string;
  ADMIN_SECRET?: string;
  SIGNING_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_PUBLIC_KEY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** Optional: the platform's own mail sending (a `send_email` binding). Used before RESEND_API_KEY. */
  EMAIL?: { send(message: { to: string; from: string; subject: string; text: string; html?: string }): Promise<unknown> };

  /** Tests only: replaces every outbound request (pages, model, push, mail, client metadata). */
  OUTBOUND?: (input: string, init?: RequestInit) => Promise<Response>;
}

export const LIMITS = CONTRACT.limits as {
  item_expiry_default_days: number;
  item_expiry_max_days: number;
  expiry_options_default: number[];
  claim_minutes: number;
  claim_max_items: number;
  device_code_minutes: number;
  login_code_minutes: number;
  login_code_max_attempts: number;
  device_idle_days: number;
  asset_max_bytes: number;
  storage_quota_bytes: number;
  triage_per_user_per_day: number;
  triage_default_after_minutes: number;
  page_fetch_timeout_seconds: number;
  queue_idle_days: number;
  analysis_summary_max_chars: number;
  analysis_key_fact_max_chars: number;
  analysis_point_max_chars: number;
  analysis_points_max: number;
  notify_wait_seconds: number;
  notify_max_wait_seconds: number;
  text_max_chars: number;
};

export function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function outbound(env: Env, input: string, init?: RequestInit): Promise<Response> {
  return env.OUTBOUND ? env.OUTBOUND(input, init) : fetch(input, init);
}

export function signingKey(env: Env): string {
  if (!env.SIGNING_KEY) throw new Error("SIGNING_KEY is not set");
  return env.SIGNING_KEY;
}
