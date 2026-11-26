// Feedback from a user to the operator of this deployment. Stored here; passed on to an issue
// tracker (a GitHub repository) when the operator configured one.
import { now } from "../clock";
import { LIMITS, outbound, type Env } from "../env";
import { err } from "../errors";
import { rateLimit } from "../services/guard";
import { foundSentence, noFound, redact, type Kind } from "../services/redact";
import { ok, type Handler, type UserRow } from "../types";
import { newId } from "../util";

const DAY = 24 * 60 * 60 * 1000;
const PLACES = ["web", "ios", "android", "extension", "assistant", "other"];
/** After this many failures an entry is left for the operator to read in the portal. */
const FORWARD_ATTEMPTS_MAX = 5;

export interface FeedbackRow {
  seq: number;
  id: string;
  user_id: string;
  email: string;
  client: string;
  place: string;
  doing: string;
  wrong: string;
  wish: string;
  lang: string;
  created_at: number;
  issue_url: string | null;
  forward_attempts: number;
  forward_error: string | null;
}

export const forwardingConfigured = (env: Env) => !!(env.FEEDBACK_GITHUB_TOKEN && /^[\w.-]+\/[\w.-]+$/.test(env.FEEDBACK_GITHUB_REPO ?? ""));

/** `POST /v1/feedback` */
export const sendFeedback: Handler = async (cx) => {
  const user = cx.user as UserRow;
  const b = cx.body as { where?: string; doing?: string; wrong: string; wish?: string };
  const wrong = b.wrong.trim();
  if (!wrong) throw err("bad_request", "请写下哪里不对劲。", "Say what went wrong.");
  await rateLimit(cx.env, `feedback:${user.id}`, LIMITS.feedback_per_user_per_day, DAY);
  const client = cx.device?.client ?? "";
  const place = b.where && PLACES.includes(b.where) ? b.where : PLACES.includes(client) ? client : "other";
  const id = newId("fb");
  await cx.env.DB.prepare(
    "INSERT INTO feedback (id, user_id, email, client, place, doing, wrong, wish, lang, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, user.id, user.email, client, place, (b.doing ?? "").trim(), wrong, (b.wish ?? "").trim(), user.lang, now())
    .run();
  // Passing it on must not make the user wait or fail: the minute job tries again.
  if (forwardingConfigured(cx.env)) {
    const job = forwardOne(cx.env, id).catch(() => {});
    if (cx.exec) cx.exec.waitUntil(job);
  }
  return ok({ id }, 201);
};

const HEAD: Record<string, [string, string, string, string]> = {
  zh: ["在哪个端", "当时在做什么", "哪里不对劲", "希望它怎样"],
  en: ["Where", "What I was doing", "What went wrong", "How I would like it to be"],
};

/**
 * The issue as the tracker gets it. The title is the first line of what went wrong.
 *
 * The tracker is not private to the operator, so what the user typed goes there with emails, phone
 * numbers and anything that looks like a credential masked (QA #78), and the sender is not named:
 * the feedback id is the link, and the operator reads the original and the sender in the portal.
 */
export function issueOf(r: FeedbackRow): { title: string; body: string; labels: string[] } {
  const found = noFound();
  const clean = (text: string) => {
    // The sender's own address is masked wherever it still shows, however it was written.
    const out = redact(text, [r.email]);
    for (const k of Object.keys(found) as Kind[]) found[k] += out.found[k];
    return out.text;
  };
  const place = clean(r.place);
  const doing = clean(r.doing);
  const wrong = clean(r.wrong);
  const wish = clean(r.wish);
  // Masked first, shortened after: a cut in the middle of a credential would leave a part of it.
  const first = wrong.split(/\r?\n/)[0].trim();
  const title = `[${place}] ${first.length > 80 ? first.slice(0, 79) + "…" : first}`;
  const h = HEAD[r.lang] ?? HEAD.en;
  const part = (name: string, text: string) => (text ? `### ${name}\n\n${text}\n\n` : "");
  const masked = foundSentence(found);
  const body =
    part(h[0], place) + part(h[1], doing) + part(h[2], wrong) + part(h[3], wish) +
    `---\nfeedback id: ${r.id} · ${new Date(r.created_at).toISOString()} · client: ${r.client || "?"}\nSent from inside the app. The sender is in the portal under this feedback id.` +
    (masked ? `\nMasked in this text: ${masked}. The original is in the portal.` : "");
  return { title, body, labels: ["feedback", "in-app"] };
}

/** Why a request to the tracker failed, in words that carry no user text, address or credential. */
function whyFailed(env: Env, e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  return redact(message, [env.FEEDBACK_GITHUB_TOKEN]).text.slice(0, 200) || "request failed";
}

/** Passes one entry on. Records where it went, or why it did not go. */
export async function forwardOne(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT * FROM feedback WHERE id = ? AND issue_url IS NULL").bind(id).first<FeedbackRow>();
  if (!r || !forwardingConfigured(env)) return false;
  let problem = "";
  try {
    const res = await outbound(env, `https://api.github.com/repos/${env.FEEDBACK_GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.FEEDBACK_GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "keepessence-core",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify(issueOf(r)),
    });
    if (res.ok) {
      const url = ((await res.json()) as { html_url?: string }).html_url ?? "";
      if (url) {
        await env.DB.prepare("UPDATE feedback SET issue_url = ?, forward_error = NULL WHERE id = ?").bind(url, id).run();
        return true;
      }
      problem = "no address in the answer";
    } else problem = `status ${res.status}`;
  } catch (e) {
    problem = whyFailed(env, e);
  }
  await env.DB.prepare("UPDATE feedback SET forward_attempts = forward_attempts + 1, forward_error = ? WHERE id = ?").bind(problem, id).run();
  return false;
}

/** The minute job: entries that have not gone out yet, a few at a time. */
export async function forwardPending(env: Env): Promise<number> {
  if (!forwardingConfigured(env)) return 0;
  const rows = await env.DB.prepare("SELECT id FROM feedback WHERE issue_url IS NULL AND forward_attempts < ? ORDER BY rowid LIMIT 5")
    .bind(FORWARD_ATTEMPTS_MAX)
    .all<{ id: string }>();
  let sent = 0;
  for (const r of rows.results) if (await forwardOne(env, r.id)) sent++;
  return sent;
}
