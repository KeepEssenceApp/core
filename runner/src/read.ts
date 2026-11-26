// One address, read as the core's direct read would: a desktop and then a phone, a wall or a shell
// goes on to the next, and what comes back is judged by the one set of rules in core/src/services/pagerules.ts.
import { assessPage, onDomain, hostOf, REFUSAL_STATUSES, usableTitle, userAgentsFor, wallHint } from "../../src/services/pagerules.ts";
import { isPublicUrl } from "../../src/services/publicurl.ts";
import type { Config } from "./config.ts";
import type { Renderer } from "./render.ts";

export type Failure = "invalid" | "wall" | "thin" | "timeout" | "error";
export type ReadResult = { ok: true; title: string; content: string } | { ok: false; kind: Failure; message: string };

const chars = (s: string, max: number) => ([...s].length <= max ? s : [...s].slice(0, max).join(""));

/** A short fixed list, so a log line never holds an address. */
export function platformOf(url: string): string {
  const host = hostOf(url);
  if (host === "mp.weixin.qq.com" || onDomain(host, ["weixin.qq.com"])) return "wechat";
  if (onDomain(host, ["xiaohongshu.com", "rednote.com", "xhslink.com"])) return "xiaohongshu";
  return "other";
}

export async function readUrl(renderer: Pick<Renderer, "render">, cfg: Config, url: string): Promise<ReadResult> {
  if (!isPublicUrl(url)) return { ok: false, kind: "invalid", message: "not a public address" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), cfg.deadlineMs);
  let failure: ReadResult = { ok: false, kind: "error", message: "no answer that could be read" };
  try {
    for (const ua of userAgentsFor(url)) {
      let got;
      try {
        got = await renderer.render(url, ua, deadline.signal);
      } catch {
        if (deadline.signal.aborted) return { ok: false, kind: "timeout", message: "no answer in time" };
        failure = { ok: false, kind: "error", message: "the page could not be opened" };
        break; // an error is the site's answer: another User-Agent will not change it
      }
      if (REFUSAL_STATUSES.has(got.status)) {
        failure = { ok: false, kind: "wall", message: `the site refused the read (status ${got.status})` };
        continue;
      }
      if (got.status >= 400 || got.status === 0) {
        failure = { ok: false, kind: "error", message: `status ${got.status}` };
        break;
      }
      const wall = wallHint(got);
      if (wall) {
        failure = { ok: false, kind: "wall", message: `a verification wall answered (${wall})` };
        continue;
      }
      const verdict = assessPage({ url: got.finalUrl, text: got.text, description: got.description });
      if (verdict.quality !== "ok") {
        failure = { ok: false, kind: "thin", message: verdict.reason };
        continue;
      }
      const content = chars(verdict.caption ? got.description : got.text, cfg.maxChars);
      return { ok: true, title: usableTitle(got.title, { url: got.finalUrl, site: got.site }) ? got.title : "", content };
    }
    return failure;
  } finally {
    clearTimeout(timer);
  }
}
