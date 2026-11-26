// The call to the transcription worker on the other machine: the audio goes out, the words come back.
//
//   POST {url}/transcribe?lang=auto   Authorization: Bearer {key}   body: the .ogg
//   200 { text, speech: true | false, seconds }     503 busy     413 too_long     401 / 500 and the rest: failures
//
// This is a trusted internal call: it goes straight to the worker and not through the filtering proxy (which
// only lets a page's addresses through, and would refuse the worker's private one). The key is only ever put
// in the one header; it is in no error and no log.
import { readFile } from "node:fs/promises";

export type Transcript = { kind: "text"; text: string } | { kind: "no_speech" } | { kind: "too_long" };

export interface TranscribeOptions {
  url: string;
  /** The worker's secret, sent as `Authorization: Bearer`. */
  bearer: string;
  /** Longest wait for the worker's answer (the worker may be busy with the one before). */
  timeoutMs?: number;
  /** The most text kept. */
  maxChars?: number;
  fetch?: typeof fetch;
}

const REPLY_MAX = 4 * 1024 * 1024;

/** Text, nothing said, or too long. Anything else (busy, refused, broken, unreachable, no answer in time) throws, and the job is "unavailable". */
export async function transcribeFile(o: TranscribeOptions, file: string, signal: AbortSignal): Promise<Transcript> {
  const audio = await readFile(file);
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 5 * 60 * 1000);
  const res = await (o.fetch ?? fetch)(`${o.url}/transcribe?lang=auto`, {
    method: "POST",
    headers: { authorization: `Bearer ${o.bearer}`, "content-type": "audio/ogg" },
    body: audio,
    signal: AbortSignal.any([signal, timeout]),
    redirect: "error",
  });
  if (res.status === 413) {
    await res.body?.cancel().catch(() => {});
    return { kind: "too_long" };
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new Error("the worker did not transcribe");
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > REPLY_MAX) throw new Error("the worker's answer is too large");
  let reply: { text?: unknown; speech?: unknown };
  try {
    reply = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("the worker's answer is not JSON");
  }
  const text = typeof reply.text === "string" ? reply.text.trim() : "";
  // Nothing said (music, burnt-in captions, silence) is never turned into words.
  if (reply.speech === false || !text) return { kind: "no_speech" };
  const max = o.maxChars ?? 30000;
  return { kind: "text", text: [...text].length <= max ? text : [...text].slice(0, max).join("") };
}
