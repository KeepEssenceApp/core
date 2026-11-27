// The words and the layout of the two mails the core sends (spec product/mail.md): the
// invitation notice and the sign-in code. Each mail is written once as blocks and rendered twice,
// as HTML and as plain text, so the two cannot drift apart. Nothing here sends anything or logs.
import type { Lang } from "../errors";

/** The product's name in the mails: the one place to change on a rename. */
export const MAIL_BRAND = { name: "KeepEssence", logoAlt: { en: "Keep Essence", zh: "精华" } } as const;

/** The official lockups (marketing/brand/lockup), published by the web app under /brand/. Width follows the file's own ratio at this height. */
const LOGO_HEIGHT = 32;
const LOGO = {
  en: { file: "lockup-en-black.png", width: 137 },
  zh: { file: "lockup-zh-black.png", width: 73 },
} as const;

/** The light values of design/tokens.css. Gold is not here on purpose: it lives only in the logo's dot. */
const C = { bg: "#F9F6F4", card: "#FFFDFC", line: "#D7D1CF", text: "#252321", text2: "#45403D", text3: "#605B59", quiet: "#EEECEC" } as const;
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Hiragino Sans GB','Noto Sans SC','Microsoft YaHei','Segoe UI',Roboto,'Helvetica Neue',sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

/** What the deployment tells the mails; each piece is optional and its sentence is left out when it is missing: nothing is invented. */
export interface MailContext {
  /** The web app's address (APP_ORIGIN): where to sign in, and where the logo is hosted. */
  origin?: string;
  /** The sender's bare address, from EMAIL_FROM. */
  sender?: string;
  /** The contact address (MAIL_CONTACT). */
  contact?: string;
}

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** `KeepEssence <login@keepessence.app>` or a bare address, to the bare address; undefined when it is neither. */
export function bareAddress(from: string | undefined): string | undefined {
  const value = (from ?? "").trim();
  const inBrackets = value.match(/<([^<>]+)>\s*$/);
  const candidate = (inBrackets ? inBrackets[1] : value).trim();
  return ADDRESS.test(candidate) ? candidate : undefined;
}

/** The mail's view of the deployment: the optional pieces, each only when it is usable. */
export function mailContext(env: { APP_ORIGIN?: string; PUBLIC_ORIGIN?: string; EMAIL_FROM?: string; MAIL_CONTACT?: string }): MailContext {
  const origin = (env.PUBLIC_ORIGIN || env.APP_ORIGIN || "").trim().replace(/\/+$/, "");
  let valid: string | undefined;
  try {
    valid = /^https?:$/.test(new URL(origin).protocol) ? origin : undefined;
  } catch {
    valid = undefined;
  }
  const contact = (env.MAIL_CONTACT ?? "").trim();
  return { origin: valid, sender: bareAddress(env.EMAIL_FROM), contact: ADDRESS.test(contact) ? contact : undefined };
}

// ---------------------------------------------------------------- blocks

type Inline = string | { link: string; text: string };

type Block =
  | { kind: "lead"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "steps"; title: string; items: Inline[][] }
  | { kind: "code"; code: string }
  | { kind: "lines"; lines: string[] }
  | { kind: "footer"; parts: Inline[] };

interface Content {
  subject: string;
  /** Hidden preview text some mail lists show beside the subject. Never the code. */
  preheader: string;
  blocks: Block[];
}

const hostOf = (origin: string): string => new URL(origin).host;

function inviteContent(lang: Lang, cx: MailContext): Content {
  const name = MAIL_BRAND.name;
  const host = cx.origin ? hostOf(cx.origin) : null;
  const home: Inline = host ? { link: cx.origin!, text: host } : name;
  if (lang === "zh") {
    return {
      subject: `你可以开始用 ${name} 了`,
      preheader: `你可以开始用 ${name} 了。`,
      blocks: [
        { kind: "lead", text: `你可以开始用 ${name} 了。` },
        { kind: "paragraph", text: "把想看的东西存入，内置助手会先读一遍，告诉你哪些值得花时间。真正留下什么，由你决定。" },
        {
          kind: "steps",
          title: "接下来：",
          // The button names are the web app's own words (its i18n `inbox.paste`, `nav.digest`): when they change there, they change here.
          items: [
            ["用电脑或手机浏览器打开 ", home, "，在「今天」点底部的「从剪贴板存入」，存入你复制好的链接、文字或图片；想自己输入，点旁边的圆形按钮。每晚 21:00 之后看「每日摘要」。"],
            [cx.sender ? `登录验证码由 ${cx.sender} 发出；没收到请看一下垃圾邮件。` : "没收到登录验证码请看一下垃圾邮件。"],
          ],
        },
        {
          kind: "footer",
          parts: [`这个邮箱已获邀加入 ${name} 内测，所以收到这封邮件。如果不是你本人，忽略即可。`, ...(cx.contact ? ["有问题请写信到 ", { link: `mailto:${cx.contact}`, text: cx.contact }, "。"] : [])],
        },
      ],
    };
  }
  return {
    subject: `You're in: ${name}`,
    preheader: `You can start using ${name}.`,
    blocks: [
      { kind: "lead", text: `You can start using ${name}.` },
      { kind: "paragraph", text: "Save what you want to read. The built-in assistant reads it first and tells you what's worth your time. What you keep is up to you." },
      {
        kind: "steps",
        title: "Next:",
        items: [
          [
            "Open ",
            home,
            " in a browser on your computer or phone. On Today, press “Save from clipboard” at the bottom to save a link, text or picture you copied; to type instead, press the round button beside it. After 21:00 each evening, read your Daily digest.",
          ],
          [cx.sender ? `Sign-in codes come from ${cx.sender}; if one doesn't arrive, check your spam folder.` : "If a sign-in code doesn't arrive, check your spam folder."],
        ],
      },
      {
        kind: "footer",
        parts: [
          `You're receiving this because this email address has been invited to the ${name} beta. If that isn't you, you can ignore this email.`,
          ...(cx.contact ? [" Questions: ", { link: `mailto:${cx.contact}`, text: cx.contact }, "."] : []),
        ],
      },
    ],
  };
}

function signinContent(lang: Lang, code: string, minutes: number): Content {
  const name = MAIL_BRAND.name;
  if (lang === "zh") {
    return {
      subject: `你的 ${name} 登录验证码`,
      preheader: "请回到登录页输入验证码。",
      blocks: [
        { kind: "lead", text: "在登录页输入这个验证码：" },
        { kind: "code", code },
        { kind: "lines", lines: [`验证码 ${minutes} 分钟内有效，只能用一次。`, "如果不是你本人在登录，忽略这封邮件即可。"] },
      ],
    };
  }
  return {
    subject: `Your ${name} sign-in code`,
    preheader: "Go back to the sign-in page and enter the code.",
    blocks: [
      { kind: "lead", text: "Enter this code on the sign-in page:" },
      { kind: "code", code },
      { kind: "lines", lines: [`This code works once and expires in ${minutes} minutes.`, "If you did not try to sign in, ignore this email."] },
    ],
  };
}

// ---------------------------------------------------------------- plain text

const plainInline = (parts: Inline[]): string => parts.map((p) => (typeof p === "string" ? p : p.text)).join("");

function renderText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "lead" || b.kind === "paragraph") out.push(b.text);
    else if (b.kind === "code") out.push(b.code);
    else if (b.kind === "lines") out.push(b.lines.join("\n"));
    else if (b.kind === "steps") out.push([b.title, ...b.items.map((item, i) => `${i + 1}. ${plainInline(item)}`)].join("\n"));
    else out.push(plainInline(b.parts));
  }
  return out.join("\n\n") + "\n";
}

// ---------------------------------------------------------------- HTML

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const htmlInline = (parts: Inline[]): string =>
  parts.map((p) => (typeof p === "string" ? esc(p) : `<a href="${esc(p.link)}" style="color:${C.text};text-decoration:underline;">${esc(p.text)}</a>`)).join("");

function renderBlock(b: Block): string {
  const body = `font-family:${FONT};color:${C.text};font-size:16px;line-height:1.6;`;
  if (b.kind === "lead") return `<p style="margin:0 0 16px 0;${body}font-size:20px;line-height:1.4;font-weight:600;">${esc(b.text)}</p>`;
  if (b.kind === "paragraph") return `<p style="margin:0 0 20px 0;${body}color:${C.text2};">${esc(b.text)}</p>`;
  if (b.kind === "code")
    return `<p style="margin:0 0 20px 0;padding:16px 20px;background:${C.quiet};border-radius:14px;text-align:center;font-family:${MONO};font-size:32px;line-height:1.2;font-weight:700;letter-spacing:8px;color:${C.text};">${esc(b.code)}</p>`;
  if (b.kind === "lines") return b.lines.map((l, i) => `<p style="margin:0 0 ${i === b.lines.length - 1 ? 0 : 8}px 0;${body}color:${C.text2};">${esc(l)}</p>`).join("");
  if (b.kind === "steps") {
    const rows = b.items
      .map(
        (item, i) =>
          `<tr><td valign="top" style="padding:0 10px 10px 0;${body}color:${C.text3};">${i + 1}.</td><td valign="top" style="padding:0 0 10px 0;${body}color:${C.text2};">${htmlInline(item)}</td></tr>`,
      )
      .join("");
    return `<p style="margin:0 0 8px 0;${body}font-weight:600;">${esc(b.title)}</p><table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px 0;">${rows}</table>`;
  }
  return `<p style="margin:0;font-family:${FONT};color:${C.text3};font-size:13px;line-height:1.6;">${htmlInline(b.parts)}</p>`;
}

/** Enough invisible characters after the preview text that a mail list does not go on to show the body (the sign-in code) beside the subject. */
const PREVIEW_PAD = "&#847;&zwnj;&nbsp;".repeat(90);

function renderHtml(lang: Lang, content: Content, cx: MailContext): string {
  const logo = LOGO[lang];
  const alt = esc(MAIL_BRAND.logoAlt[lang]);
  const header = cx.origin
    ? `<img src="${esc(`${cx.origin}/brand/${logo.file}`)}" width="${logo.width}" height="${LOGO_HEIGHT}" alt="${alt}" style="display:block;border:0;outline:none;text-decoration:none;width:${logo.width}px;height:${LOGO_HEIGHT}px;font-family:${FONT};font-size:18px;font-weight:700;color:${C.text};">`
    : `<span style="font-family:${FONT};font-size:18px;font-weight:700;letter-spacing:0.04em;color:${C.text};">${alt}</span>`;
  const blocks = content.blocks.filter((b) => b.kind !== "footer").map(renderBlock).join("");
  const footer = content.blocks.filter((b) => b.kind === "footer").map(renderBlock).join("");
  return [
    `<!doctype html>`,
    `<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(content.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:${C.bg};">`,
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${esc(content.preheader)}${PREVIEW_PAD}</div>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${C.card};border:1px solid ${C.line};border-radius:20px;">`,
    `<tr><td style="padding:20px 28px;border-bottom:1px solid ${C.line};">${header}</td></tr>`,
    `<tr><td style="padding:28px;">${blocks}</td></tr>`,
    footer ? `<tr><td style="padding:16px 28px 24px 28px;border-top:1px solid ${C.line};">${footer}</td></tr>` : "",
    `</table></td></tr></table></body></html>`,
  ].join("");
}

function render(lang: Lang, content: Content, cx: MailContext): Rendered {
  return { subject: content.subject, text: renderText(content.blocks), html: renderHtml(lang, content, cx) };
}

/** The invitation notice: sent once, when the operator invites the address. It carries no code. */
export function renderInviteMail(lang: Lang, cx: MailContext): Rendered {
  return render(lang, inviteContent(lang, cx), cx);
}

/** The sign-in code. The code is in the body only: not in the subject, and not the first line of either part. */
export function renderSigninMail(lang: Lang, code: string, minutes: number, cx: MailContext): Rendered {
  return render(lang, signinContent(lang, code, minutes), cx);
}
