// The assistant operations of the contract. Each is one function taking (context) and calling
// the work service. REST handlers and the tools on the assistant endpoint both run these.
import { NO_CONTENT, ok, type Cx, type Handler, type Step } from "../types";
import { getUser } from "../services/accounts";
import { idempotent } from "../services/guard";
import { createNote, noteView } from "../services/notes";
import {
  claimWork,
  getContext,
  getDigestContext,
  getRules,
  listDeepDiveCandidates,
  listWork,
  registerDeepDive,
  releaseClaim,
  renewClaim,
  requireStep,
  searchDigestsAndNotes,
  submitResults,
} from "../services/work";

const actor = (cx: Cx) => cx.assistant!;

export const ASSISTANT_HANDLERS: Record<string, Handler> = {
  getWork: async (cx) => ok(await listWork(cx.env, actor(cx))),
  claimWork: async (cx) => ok(await claimWork(cx.env, actor(cx), cx.body.kind, cx.body.limit)),
  renewClaim: async (cx) => ok(await renewClaim(cx.env, actor(cx), cx.path.id)),
  releaseClaim: async (cx) => {
    await releaseClaim(cx.env, actor(cx), cx.path.id);
    return NO_CONTENT;
  },
  submitResult: async (cx) =>
    idempotent(cx.env, actor(cx).userId, `submitResult:${actor(cx).assistantId}`, cx.idemKey, async () =>
      ok(await submitResults(cx.env, actor(cx), cx.path.id, cx.body.results, cx.body.usage, cx.lang)),
    ),
  getRules: async (cx) => ok(await getRules(cx.env, actor(cx), cx.query.kind)),
  getContext: async (cx) => ok(await getContext(cx.env, actor(cx), cx.path.id, cx.query.for, cx.origin)),
  getDigestContext: async (cx) => ok(await getDigestContext(cx.env, actor(cx), cx.path.day)),
  searchDigestsAndNotes: async (cx) => ok(await searchDigestsAndNotes(cx.env, actor(cx), cx.query.q, cx.query.limit)),
  listDeepDiveCandidates: async (cx) => ok(await listDeepDiveCandidates(cx.env, actor(cx), cx.query.q)),
  registerDeepDive: async (cx) => ok(await registerDeepDive(cx.env, actor(cx), cx.body.item_id)),
  saveNote: async (cx) => {
    requireStep(actor(cx), "deep_dive");
    return idempotent(cx.env, actor(cx).userId, `saveNote:${actor(cx).assistantId}`, cx.idemKey, async () => {
      const note = await createNote(cx.env, await getUser(cx.env, actor(cx).userId), {
        title: cx.body.title,
        body: cx.body.body,
        itemId: cx.body.item_id,
        sources: cx.body.sources,
        assistantId: actor(cx).assistantId,
        assistantName: actor(cx).name,
        submittedBy: "assistant",
      });
      return ok(noteView(note), 201);
    });
  },
};

const WORK_STEPS: Step[] = ["triage", "analysis", "digest", "deep_read"];

/**
 * Which steps let an assistant see a tool at all (any one of them is enough). The service
 * functions check the exact step again for each call.
 */
export const TOOL_STEPS: Record<string, Step[]> = {
  claimWork: WORK_STEPS,
  renewClaim: WORK_STEPS,
  releaseClaim: WORK_STEPS,
  submitResult: WORK_STEPS,
  getRules: WORK_STEPS,
  getContext: ["triage", "analysis", "deep_read", "deep_dive"],
  getDigestContext: ["digest"],
  searchDigestsAndNotes: ["analysis", "digest", "deep_read"],
  listDeepDiveCandidates: ["deep_dive"],
  registerDeepDive: ["deep_dive"],
  saveNote: ["deep_dive"],
};
