// The words of a video (#103). The runner reads a video in the background and answers 202 with a
// job; the item waits (`fetch_state = 'video_wait'`) and the minute job asks about it. Nothing here
// waits for the runner: a question is one short request, and a runner that does not answer is only
// asked again next minute, until `fetch_deadline`.
//
// Every write is guarded by the item still being live (not archived), still waiting, and still
// holding the same job. So a late or repeated answer, an item that was archived or deleted while it
// waited, and a job that belongs to another item all change nothing; and only the one write that
// does change the item goes on to analysis.
import { now } from "../clock";
import type { Env } from "../env";
import type { ItemRow } from "../types";
import { truncate } from "../util";
import { askVideoJob, cancelVideoJob, countVideo, longEnough, type FetchSettings, type VideoEnd } from "./fetchers";

/** The longest recognized text the core keeps for one item. */
export const RECOGNIZED_MAX_CHARS = 30000;

/** How many waiting items one minute asks about, oldest first. */
export const POLLS_PER_RUN = 5;

export type WaitingItem = Pick<ItemRow, "id" | "user_id" | "url" | "body" | "fetch_job" | "fetch_deadline">;

/**
 * The item stops waiting. With the words (`recognized`) or with what the author wrote, it has
 * content and goes on as any item whose content is there; with neither it is "content could not be
 * fetched". Returns whether this call was the one that ended the wait.
 */
export async function finishVideo(env: Env, s: FetchSettings, item: WaitingItem, state: "recognized" | VideoEnd, text = "", cancel = true): Promise<boolean> {
  const recognized = state === "recognized" ? truncate(text.trim(), RECOGNIZED_MAX_CHARS) : "";
  // A "recognized" with no words in it is no speech: nothing is stored, and no words are made up.
  const ended = state === "recognized" ? (recognized ? "recognized" : "no_speech") : state;
  const content = recognized !== "" || longEnough(item.body ?? "");
  const res = await env.DB.prepare(
    `UPDATE items SET video_state = ?, recognized_text = ?, fetch_state = ?, content_unavailable = ?, fetch_job = NULL, fetch_deadline = NULL, video_done_at = ?
     WHERE id = ? AND user_id = ? AND fetch_state = 'video_wait' AND fetch_job IS ? AND archived_at IS NULL`,
  )
    .bind(ended, recognized || null, content ? "done" : "failed", content ? 0 : 1, now(), item.id, item.user_id, item.fetch_job)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;
  await countVideo(env, item.url ?? "", ended === "recognized");
  if (cancel && item.fetch_job) await cancelVideoJob(env, s, item.fetch_job);
  return true;
}

/** One waiting item: ask the runner, and end the wait when the answer ends it. */
export async function pollVideo(env: Env, s: FetchSettings, item: WaitingItem): Promise<void> {
  const job = item.fetch_job;
  // Out of time, or no job to ask about: give up. What the author wrote stays as it is.
  if (!job || (item.fetch_deadline ?? 0) <= now()) {
    await finishVideo(env, s, item, "unavailable");
    return;
  }
  const answer = await askVideoJob(env, s, job);
  if (answer.kind === "reading" || answer.kind === "silent") return;
  // The runner does not know the job any more (it restarted, or forgot it): nothing to cancel.
  if (answer.kind === "gone") {
    await finishVideo(env, s, item, "unavailable", "", false);
    return;
  }
  await finishVideo(env, s, item, answer.state, answer.text);
}

/**
 * An item that was archived (it expired, or was deleted with its copy kept) while its video was
 * being read: the job is cancelled, and the item is not touched otherwise. An item that is deleted
 * outright is cancelled by the request that deleted it.
 */
export async function cancelArchivedJob(env: Env, s: FetchSettings, item: Pick<ItemRow, "id" | "user_id" | "fetch_job">): Promise<void> {
  if (!item.fetch_job) return;
  await cancelVideoJob(env, s, item.fetch_job);
  await env.DB.prepare("UPDATE items SET fetch_job = NULL, fetch_deadline = NULL WHERE id = ? AND user_id = ? AND fetch_job = ?").bind(item.id, item.user_id, item.fetch_job).run();
}
