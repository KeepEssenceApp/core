// One address, read as the core's direct read would: a desktop and then a phone, a wall or a shell
// goes on to the next, and what comes back is judged by the one set of rules in core/src/services/pagerules.ts.
//
// A video post is read for its words as well (detect.ts says which pages are one). The words of the page are the
// author's own and are returned as they are, however short: no verdict of "thin" is made on a caption, and a video
// post with nothing written is still a video post. What is said in the video is a job (jobs.ts) that the answer
// names; a video that cannot be read is said so ("too_long", "unavailable") and never turns the page's own text
// into a failure.
import { assessPage, onDomain, hostOf, REFUSAL_STATUSES, usableTitle, userAgentsFor, wallHint } from "../../src/services/pagerules.ts";
import { isPublicUrl } from "../../src/services/publicurl.ts";
import type { Config } from "./config.ts";
import { videoByAddress, videoInFrames, videoOfNote, type VideoRef } from "./detect.ts";
import type { VideoAnswer } from "./jobs.ts";
import type { Rendered, Renderer } from "./render.ts";

export type Failure = "invalid" | "wall" | "thin" | "timeout" | "error";
export type ReadResult = { ok: true; title: string; content: string; video?: VideoAnswer } | { ok: false; kind: Failure; message: string };

/** Decides what becomes of a video post: a job is started for it, or it is told why not. `signal` is the read's one deadline. */
export type ResolveVideo = (ref: VideoRef, platform: string, signal: AbortSignal) => Promise<VideoAnswer>;

const chars = (s: string, max: number) => ([...s].length <= max ? s : [...s].slice(0, max).join(""));

/** A short fixed list, so a log line never holds an address. */
export function platformOf(url: string): string {
  const host = hostOf(url);
  if (host === "mp.weixin.qq.com" || onDomain(host, ["weixin.qq.com"])) return "wechat";
  if (onDomain(host, ["xiaohongshu.com", "rednote.com", "xhslink.com"])) return "xiaohongshu";
  if (onDomain(host, ["bilibili.com", "b23.tv"])) return "bilibili";
  if (onDomain(host, ["weibo.com", "weibo.cn"])) return "weibo";
  if (onDomain(host, ["v.qq.com"])) return "tencent";
  if (onDomain(host, ["douyin.com", "iesdouyin.com"])) return "douyin";
  return "other";
}

/** What the page that was read says about a video: its address, its own data, or (a WeChat article) the iframes in it. */
function videoOf(asked: VideoRef | null, got: Rendered): VideoRef | null {
  // A post that cannot be read stays one that cannot be read, wherever the address went on to.
  if (asked?.kind === "unsupported") return asked;
  const byAddress = videoByAddress(got.finalUrl);
  if (byAddress) return byAddress;
  if (got.post?.video) return videoOfNote(got.post.video, got.finalUrl);
  if (hostOf(got.finalUrl) === "mp.weixin.qq.com") return videoInFrames(got.frames);
  return null;
}

export async function readUrl(renderer: Pick<Renderer, "render">, cfg: Config, url: string, resolveVideo?: ResolveVideo): Promise<ReadResult> {
  if (!isPublicUrl(url)) return { ok: false, kind: "invalid", message: "not a public address" };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), cfg.deadlineMs);
  const platform = platformOf(url);
  const asked = videoByAddress(url);
  let video: VideoRef | null = asked;
  /** The page's words, and the answer about its video. */
  const withVideo = async (ref: VideoRef, title: string, content: string): Promise<ReadResult> => {
    // Whatever goes wrong with the video, the page's own words are still returned.
    let answer: VideoAnswer = { state: "unavailable", seconds: null };
    if (resolveVideo) {
      try {
        answer = await resolveVideo(ref, platform, deadline.signal);
      } catch {
        /* unavailable */
      }
    }
    return { ok: true, title, content: chars(content, cfg.maxChars), video: answer };
  };
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
      video = videoOf(asked, got);
      if (REFUSAL_STATUSES.has(got.status)) {
        failure = { ok: false, kind: "wall", message: `the site refused the read (status ${got.status})` };
        continue;
      }
      if (got.status >= 400 || got.status === 0) {
        failure = { ok: false, kind: "error", message: `status ${got.status}` };
        break;
      }
      // A page whose own data says it is a video note is not a wall: the data is the post's.
      const wall = got.post?.video ? null : wallHint(got);
      if (wall) {
        failure = { ok: false, kind: "wall", message: `a verification wall answered (${wall})` };
        continue;
      }
      // A site whose own data says what the post is: the post is all that is judged and all that is returned.
      // (A page's comments and a feed of other posts are not the post, and a short post is not made longer by them.)
      const post = got.post;
      const verdict = assessPage({ url: got.finalUrl, text: post ? post.text : got.text, description: post ? post.text : got.description });
      const title = post?.title || got.title;
      const shown = usableTitle(title, { url: got.finalUrl, site: got.site }) ? title : "";
      if (video) {
        // The author's own words, as they are: the note's data is returned whole (but for a name alone); a page's text only when the page rules take it for content.
        const own = post ? (post.bare ? "" : post.text) : verdict.quality === "ok" ? (verdict.caption ? got.description : got.text) : "";
        return await withVideo(video, shown, own);
      }
      if (verdict.quality !== "ok") {
        failure = { ok: false, kind: "thin", message: verdict.reason };
        continue;
      }
      const body = post ? post.text : verdict.caption ? got.description : got.text;
      return { ok: true, title: shown, content: chars(body, cfg.maxChars) };
    }
    // A video post whose page gave no words (a wall, a shell) still has its video: "no words at all" is an empty text and not a failure.
    if (video && !failure.ok && (failure.kind === "wall" || failure.kind === "thin")) return await withVideo(video, "", "");
    return failure;
  } finally {
    clearTimeout(timer);
  }
}
