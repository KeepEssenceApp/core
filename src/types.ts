import type { ContractOperation } from "./contract-types";
import type { Env } from "./env";
import type { Lang } from "./errors";

export type Tier = "save" | "read" | "manage";
export type Step = "triage" | "analysis" | "digest" | "deep_read" | "deep_dive";
export type WorkKind = "triage" | "analysis" | "digest" | "deep_read";

export interface UserRow {
  id: string;
  email: string;
  timezone: string;
  lang: Lang;
  storage_bytes: number;
  notify: number;
  rules: string;
  preference: string | null;
  expiry_options: string;
  role_analysis: string | null;
  role_digest: string | null;
  role_deep_read: string | null;
  role_deep_dive: string | null;
  calendar_enabled: number;
  calendar_secret: string | null;
  created_at: number;
  /** Set by the operator: while it is set, nothing of this account works. */
  suspended_at: number | null;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  name: string;
  client: string;
  tier: Tier;
  credential_hash: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AssistantRow {
  id: string;
  user_id: string;
  name: string;
  kind: "scheduled" | "chat";
  steps: string;
  built_in: "dispatch" | "worker" | null;
  client_id: string | null;
  runs_at: string | null;
  connected_at: number | null;
  last_seen_at: number | null;
  revoked_at: number | null;
}

/** An assistant acting for one user. Built-in assistants use the same shape. */
export interface AssistantActor {
  userId: string;
  assistantId: string;
  name: string;
  kind: "scheduled" | "chat";
  steps: Step[];
  builtIn: "dispatch" | "worker" | null;
}

export interface ItemRow {
  id: string;
  user_id: string;
  kind: "link" | "text" | "image" | "file";
  url: string | null;
  url_key: string | null;
  title: string;
  title_from: string;
  site: string | null;
  opening: string;
  body: string | null;
  asset_id: string | null;
  source: string;
  content_unavailable: number;
  /** pending: the page is being read; video_wait: the words of its video are being read (#103); done, failed, none. */
  fetch_state: string;
  fetch_attempts: number;
  /** The reader service's job while `fetch_state` is video_wait (and, for an archived item, until it is cancelled). */
  fetch_job: string | null;
  fetch_deadline: number | null;
  video_state: "reading" | "recognized" | "no_speech" | "too_long" | "unavailable" | null;
  recognized_text: string | null;
  video_done_at: number | null;
  /** How often the built-in assistant failed to analyse it (QA #20). */
  analysis_attempts: number;
  pinned: number;
  expiry_days: number;
  expires_at: number;
  hard_expires_at: number;
  queue_holds: number;
  dispatch_to: string | null;
  triaged_at: number | null;
  analysed_at: number | null;
  digest_day: string | null;
  signal: string | null;
  viewed_at: number | null;
  claim_id: string | null;
  claim_expires_at: number | null;
  archived_at: number | null;
  created_at: number;
}

export interface OpInput {
  path: Record<string, string>;
  query: Record<string, any>;
  body: Record<string, any>;
  idemKey?: string;
}

/** Everything a handler gets. */
export interface Cx extends OpInput {
  env: Env;
  op: ContractOperation;
  lang: Lang;
  /** Public origin of the core, for addresses it hands out. */
  origin: string;
  exec?: ExecutionContext;
  request?: Request;
  bearer?: string | null;
  user?: UserRow;
  device?: DeviceRow;
  assistant?: AssistantActor;
}

export interface Result {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (cx: Cx) => Promise<Result | Response>;

export function ok(body: unknown, status = 200): Result {
  return { status, body };
}

export const NO_CONTENT: Result = { status: 204 };
