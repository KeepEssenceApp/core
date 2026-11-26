// What a page the core read directly is worth, and which title to keep. Pure functions: no
// requests, no database. One place for the rules, so that every way of reading a page (the
// direct read now, a self-hosted runner later) judges a page the same way.
//
// These are the direct-read rules of the old prototype, rewritten for the core (QA #100):
//   1. which User-Agent to ask with, and in what order        userAgentsFor
//   2. is the answer a verification wall                       wallHint
//   3. is it content, or only the shell around content         assessPage
//   4. is a title worth keeping                                usableTitle, titleWins
// Only the rules came over, not the prototype's structure, cookies or interfaces (A10). Hosts are
// matched on a domain boundary (the host is the domain or a subdomain of it), never as a substring
// of the whole address, so `notxiaohongshu.com` and `/xiaohongshu.com` in a path are not Xiaohongshu.

/** A page with less text than this is a shell (navigation words, a verification wall), not content. */
export const THIN_CHARS = 60;

export const UA_DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
export const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
export const ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9,en;q=0.8";

// ---------------------------------------------------------------- hosts

/** The host of an address, lower case, without a trailing dot; "" when it is not an address. */
export function hostOf(raw: string): string {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith(".") ? host.slice(0, -1) : host;
  } catch {
    return "";
  }
}

/** True when `host` is one of the domains or a subdomain of one. */
export function onDomain(host: string, domains: readonly string[]): boolean {
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// Apps whose pages are better asked for with a phone User-Agent first.
const PHONE_FIRST = [
  "xiaohongshu.com", "xhslink.com", "rednote.com", "rednotecdn.com", "douyin.com", "iesdouyin.com", "bilibili.com", "b23.tv",
  "weibo.com", "weibo.cn", "t.cn", "kuaishou.com", "zhihu.com",
];
// Posts that are legitimately short: a caption is the content.
const SHORT_FORM = [
  "x.com", "twitter.com", "weibo.com", "weibo.cn", "xiaohongshu.com", "xhslink.com", "rednote.com", "douyin.com", "iesdouyin.com",
  "bilibili.com", "b23.tv", "instagram.com", "threads.net",
];

/** The User-Agents to try, in order: desktop then iPhone; the phone first for the apps above. */
export function userAgentsFor(url: string): string[] {
  return onDomain(hostOf(url), PHONE_FIRST) ? [UA_IPHONE, UA_DESKTOP] : [UA_DESKTOP, UA_IPHONE];
}

// ---------------------------------------------------------------- walls

/** Words a verification wall, a login or an error page says. Seeing one at the top of a page means it was blocked. */
export const WALL_HINTS = [
  "环境异常", "去验证", "完成验证", "Weixin Official Accounts Platform", "请在微信客户端打开",
  "访问过于频繁", "Just a moment...", "Enable JavaScript and cookies", "参数错误", "该内容已被发布者删除",
];

const WALL_TEXT_HEAD = 600;
const WALL_HTML_HEAD = 20000;
/** Below this much text the page is short enough that a wall word anywhere in its first markup counts. */
const WALL_SHORT_PAGE = 400;

const letters = (s: string): number => [...s.replace(/[^\p{L}\p{N}]+/gu, "")].length;

/**
 * The first wall word in what the page shows at its top, or null. The title, the description and the
 * first lines of text always count. The first 20,000 characters of the markup count only for a short
 * page (a wall is a few lines, an article is not): a long article that mentions "完成验证" in a script
 * or a menu is still an article.
 */
export function wallHint(page: { title?: string; description?: string; text?: string; noscript?: string; head?: string }): string | null {
  const text = page.text ?? "";
  const seen = [page.title ?? "", page.description ?? "", text.slice(0, WALL_TEXT_HEAD), (page.noscript ?? "").slice(0, WALL_TEXT_HEAD)];
  if (letters(text) < WALL_SHORT_PAGE) seen.push((page.head ?? "").slice(0, WALL_HTML_HEAD));
  const hay = seen.join("\n");
  return WALL_HINTS.find((h) => hay.includes(h)) ?? null;
}

// ---------------------------------------------------------------- shells

export type Quality = "ok" | "thin" | "blocked";
export interface Verdict {
  quality: Quality;
  /** Why, in a few words. Never page text. */
  reason: string;
  /** The page is a short post whose description stands as its content (use the description as the text). */
  caption?: boolean;
}

/** A short post's description is the content from this length on. Under THIN_CHARS on purpose: see assessPage. */
export const CAPTION_CHARS = 40;
/** A WeChat article body is thousands of characters; much less means only the page's buttons came back. */
const WECHAT_MIN = 200;

/** (letters in lines that are prose, non-empty lines, lines of six letters or fewer). Short lines are buttons and menus, not prose. */
function shape(text: string): { chars: number; lines: number; short: number } {
  let chars = 0;
  let lines = 0;
  let short = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    lines++;
    const n = letters(line);
    if (n <= 6) short++;
    else chars += n;
  }
  return { chars, lines, short };
}

/**
 * Is what was extracted something that can be read as the page's content?
 *   blocked  a wall word was found (pass `wall` from wallHint);
 *   thin     only the shell was extracted: too little text, a WeChat article without its body, or a
 *            column of buttons and short menu lines;
 *   ok       otherwise.
 *
 * The existing floor stays: under THIN_CHARS (60) characters of text is not content (A13). One
 * exception, narrower than the prototype's: on a short-post site (Xiaohongshu, Weibo, Douyin, X ...)
 * a description of CAPTION_CHARS (40) characters or more is the post, and is what is kept as its text.
 * The prototype also let such a site's body pass at 15 characters; here that would let the site's
 * own menu words ("Explore", "Notifications") through, so it is not ported.
 * A Channels share page (weixin.qq.com/sph/...) redirects to a shell that holds only scripts: it has
 * no text, so it is thin like any other shell.
 */
export function assessPage(a: { url: string; text: string; description?: string; wall?: string | null }): Verdict {
  if (a.wall) return { quality: "blocked", reason: `wall: ${a.wall}` };
  const host = hostOf(a.url);
  const description = (a.description ?? "").replace(/\s+/g, " ").trim();
  if (onDomain(host, SHORT_FORM) && [...description].length >= CAPTION_CHARS) return { quality: "ok", reason: "a short post: its description is the content", caption: true };
  const { chars, lines, short } = shape(a.text);
  const flat = [...a.text.replace(/\s+/g, "")].length;
  if (host === "mp.weixin.qq.com" && chars < WECHAT_MIN) return { quality: "thin", reason: "the article's body is missing (only page buttons came back)" };
  if (lines >= 8 && short / lines >= 0.6 && chars < 400) return { quality: "thin", reason: "only page buttons and menus came back" };
  if (flat < THIN_CHARS) return { quality: "thin", reason: "too little text" };
  return { quality: "ok", reason: "" };
}

// ---------------------------------------------------------------- titles

// A title of a login, error, verification or loading page: the phrase is the whole title, or it
// opens the title and a separator follows ("登录 - 知乎", "Log in | Example"). "Error handling in
// Rust" and "Verify your backups" are titles; "Error", "404 Not Found" and "Just a moment..." are not.
// Only letters and digits count as part of a title: "我的登录页" is a title, "登录 - 知乎" is not.
const NOT_TEXT = "[^\\p{L}\\p{N}]";
const JUNK_PHRASES =
  "log\\s?in|sign\\s?in|sign\\s?up|登录|登陆|请登录|请先登录|注册|扫码登录|扫码|access denied|forbidden|unauthorized|page not found|not found|error|untitled|loading|redirecting|" +
  "just a moment|attention required|verification|security check|安全验证|安全检查|验证码|captcha|robot check|are you (?:a )?(?:human|robot)|请稍候|请稍等|出错了|页面不存在|页面找不到|无法访问|访问受限|无标题|" +
  "(?:40[0134]|50[0234])(?:\\s*(?:error|not found|forbidden|unauthorized|bad request|bad gateway|service unavailable|internal server error|gateway time-?out|access denied))?";
const TITLE_JUNK = new RegExp(`^${NOT_TEXT}*(?:${JUNK_PHRASES})(?:${NOT_TEXT}*$|${NOT_TEXT}*[-–—|:：·])`, "iu");
const TITLE_MAX_JUNK = 40;
/** An address in the shape of a title: with a scheme, with www, or a host and a path. */
const TITLE_URL = /^(?:https?:[/_]{2}|www\.)|^[\w-]+(?:\.[\w-]+)+\/\S*$/i;

const same = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Does this title name the page? Not when it is empty or one character, an address, a wall word, a
 * login / error / verification page's title, or only the site's name (the `site` the page gave, or the host).
 */
export function usableTitle(title: string | null | undefined, ctx: { url?: string; site?: string | null } = {}): boolean {
  const t = (title ?? "").replace(/\s+/g, " ").trim();
  if ([...t].length < 2 || TITLE_URL.test(t)) return false;
  if (WALL_HINTS.some((h) => t.includes(h))) return false;
  if ([...t].length <= TITLE_MAX_JUNK && TITLE_JUNK.test(t)) return false;
  const host = hostOf(ctx.url ?? "");
  const names = new Set([same(ctx.site ?? ""), host, host.replace(/^www\./, "")]);
  names.delete("");
  return !names.has(same(t));
}

/**
 * Does `candidate` replace `current`? Not when it is only a small piece of it: contained in it and
 * under half its length ("Notes" from "Notes on leases and claims") adds nothing.
 */
export function titleWins(current: string | null | undefined, candidate: string): boolean {
  const cur = same(current ?? "");
  const cand = same(candidate);
  if (!cand) return false;
  return !(cur && cand !== cur && cur.includes(cand) && [...cand].length * 2 < [...cur].length);
}
