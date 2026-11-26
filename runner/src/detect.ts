// Which pages are a video post, and where their video is. Pure functions: no requests. The page read
// (read.ts) asks them with the address and with what the page's own data said.
//
// A video the runner may read is one of three things:
//   direct       the page's own data holds the media addresses and the duration (a Xiaohongshu video note);
//   page         a media page that yt-dlp understands (Bilibili, a Weibo video, Tencent Video, the Tencent
//                video embedded in a WeChat article);
//   unsupported  a post that is a video but cannot be read: WeChat Channels (the file needs a temporary
//                credential and is encrypted) and Douyin (needs a login). They are told apart from a plain
//                page so that the answer says "video not read" and not nothing.
// Only an address that this module built or checked is ever handed to yt-dlp.
import { hostOf, onDomain } from "../../src/services/pagerules.ts";
import { isPublicUrl } from "../../src/services/publicurl.ts";

export type VideoRef =
  | { kind: "unsupported" }
  | { kind: "direct"; urls: string[]; seconds: number | null; referer: string }
  | { kind: "page"; page: string };

/** What a Xiaohongshu note's own data says about its video (render.ts reads it out of the page). */
export interface NoteVideo {
  seconds: number | null;
  urls: string[];
}

const BILIBILI_VIDEO = /^\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i;
/** A Tencent video's id: letters, digits and underscores (a WeChat one starts with `wxv_`). Nothing that could be another address. */
const VID = /^[A-Za-z0-9_]{4,64}$/;

/** The address of a video's own page on Tencent Video, from its id. */
export const tencentPage = (vid: string): string => `https://v.qq.com/x/page/${vid}.html`;

/**
 * What the address alone says. null when it is not known to be a video post (a plain page, or a site whose posts
 * are only videos some of the time: those are told by the page's own data, if at all).
 */
export function videoByAddress(raw: string): VideoRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = hostOf(raw);
  const path = url.pathname;
  // WeChat Channels: the share page is a shell of scripts, and the file is encrypted behind a temporary credential.
  if (host === "channels.weixin.qq.com" || (host === "weixin.qq.com" && path.startsWith("/sph/"))) return { kind: "unsupported" };
  // Douyin: the page wants a login.
  if (onDomain(host, ["douyin.com", "iesdouyin.com"])) return { kind: "unsupported" };
  // Bilibili: a video's page (the short link is followed by the browser first, and the page it ends on is asked again).
  if (host === "b23.tv") return { kind: "page", page: raw };
  const bilibili = onDomain(host, ["bilibili.com"]) ? BILIBILI_VIDEO.exec(path) : null;
  if (bilibili) {
    // Bilibili sends a phone to its mobile site with tracking in the address (`m.bilibili.com/video/BV…?site=OVERSEAS&lang=…`),
    // and yt-dlp reads nothing there. It is asked for the video's own page: the same video id on www, and only the part number kept.
    const part = url.searchParams.get("p") ?? "";
    return { kind: "page", page: `${url.protocol}//www.bilibili.com${bilibili[0]}${/^\d{1,3}$/.test(part) ? `?p=${part}` : ""}` };
  }
  // Weibo: its video pages. An ordinary post may or may not hold a video and its address does not say.
  if ((host === "video.weibo.com" && path.startsWith("/show")) || (onDomain(host, ["weibo.com", "weibo.cn"]) && path.startsWith("/tv/show/"))) return { kind: "page", page: raw };
  // Tencent Video.
  if (onDomain(host, ["v.qq.com"])) {
    if (path.startsWith("/x/page/") || path.startsWith("/x/cover/")) return { kind: "page", page: raw };
    const vid = tencentVidOf(raw);
    if (vid) return { kind: "page", page: tencentPage(vid) };
  }
  return null;
}

/** The `vid` of a Tencent Video player address (an iframe's), or null when the address is not one. */
export function tencentVidOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, "https://mp.weixin.qq.com/");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (hostOf(url.href) !== "v.qq.com") return null;
  const vid = url.searchParams.get("vid") ?? "";
  return VID.test(vid) ? vid : null;
}

/** The first Tencent video embedded in a WeChat article, from the addresses of the article's iframes (`src` and the lazy `data-src`). */
export function videoInFrames(frames: readonly string[]): VideoRef | null {
  for (const frame of frames) {
    const vid = tencentVidOf(frame);
    if (vid) return { kind: "page", page: tencentPage(vid) };
  }
  return null;
}

/** A Xiaohongshu video note: its media addresses (public ones only) and duration, with the note's own site as the referer the CDN wants. */
export function videoOfNote(note: NoteVideo, pageUrl: string): VideoRef {
  const urls = [...new Set(note.urls)].filter(isPublicUrl).slice(0, 3);
  const seconds = note.seconds !== null && Number.isFinite(note.seconds) && note.seconds > 0 ? Math.ceil(note.seconds) : null;
  let origin = "https://www.xiaohongshu.com";
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* the default stands */
  }
  return { kind: "direct", urls, seconds, referer: `${origin}/` };
}

/** A short link's own site is not the site that holds the video. */
const SITE_ALIASES: Record<string, string> = { "b23.tv": "bilibili.com" };

/**
 * The site a video belongs to, as one name (`bilibili.com`), for what is kept per site, such as the cool-down. From where
 * the video is asked for: its media page, or the page a note's own media addresses came from. null when there is none.
 */
export function siteOfRef(ref: VideoRef): string | null {
  const at = ref.kind === "page" ? ref.page : ref.kind === "direct" ? ref.referer : "";
  const host = hostOf(at);
  if (!host) return null;
  const labels = host.split(".");
  if (labels.length < 2) return null;
  // `www.example.co.uk` is `example.co.uk`, `www.bilibili.com` is `bilibili.com`.
  const second = labels[labels.length - 2];
  const registrable = labels.length >= 3 && labels[labels.length - 1].length === 2 && /^(co|com|org|net|gov|edu|ac)$/.test(second) ? labels.slice(-3).join(".") : labels.slice(-2).join(".");
  return SITE_ALIASES[registrable] ?? registrable;
}
