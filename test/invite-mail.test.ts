// #106: the invitation notice mail and the restyled sign-in code mail (spec product/mail.md).
// Nothing here reaches a network: the mail provider is a stub, and every address is made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { advance, MINUTE } from "../src/clock";
import { runMinute } from "../src/cron";
import { LIMITS } from "../src/env";
import { INVITE_MAILS_PER_RUN, sendInviteMails, SENDING_UNCONFIRMED_AFTER, settleInviteMails } from "../src/services/invitemail";
import { safeWhy, SEND_TIMEOUT_MS, sendMail } from "../src/services/mail";
import { bareAddress, mailContext, MAIL_BRAND, renderInviteMail, renderSigninMail, type MailContext } from "../src/services/mailcopy";
import { ADMIN, call, db, makeEnv, type Outbound } from "./helpers";

const CX: MailContext = { origin: "https://app.test", sender: "login@example.com", contact: "help@example.com" };
const MAIL = { RESEND_API_KEY: "re_test", EMAIL_FROM: "KeepEssence <login@example.com>", MAIL_CONTACT: "help@example.com" };

interface Sent {
  url: string;
  body: { from: string; to: string[]; subject: string; text: string; html: string };
}

/** A Resend stand-in that records what it was asked and answers with `respond`. */
function resend(sent: Sent[], respond: (s: Sent) => Response | Promise<Response> = () => Response.json({ id: "x" })): Outbound {
  return async (url, init) => {
    const s = { url, body: JSON.parse(String(init?.body)) };
    sent.push(s);
    return respond(s);
  };
}

const admin = (env: any, method: string, path: string, body?: unknown) => call(env, method, path, { token: ADMIN, body });
const invites = async (env: any) => (await admin(env, "GET", "/admin/invites")).json.invites as any[];
const stateOf = async (env: any, email: string) => (await db(env, "SELECT invite_mail_state AS state, invite_mail_reason AS reason, lang FROM invites WHERE email = ?", email))[0];

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------- the words and the layout

describe("#106 the mails' copy", () => {
  it("the invitation notice reads as the spec says, in Chinese and in English, as text", () => {
    expect(renderInviteMail("zh", CX).subject).toBe("你可以开始用 KeepEssence 了");
    expect(renderInviteMail("zh", CX).text).toBe(
      [
        "你可以开始用 KeepEssence 了。",
        "",
        "把想看的东西存入，内置助手会先读一遍，告诉你哪些值得花时间。真正留下什么，由你决定。",
        "",
        "接下来：",
        "1. 用电脑或手机浏览器打开 app.test，在「今天」点底部的「从剪贴板存入」，存入你复制好的链接、文字或图片；想自己输入，点旁边的圆形按钮。每晚 21:00 之后看「每日摘要」。",
        "2. 登录验证码由 login@example.com 发出；没收到请看一下垃圾邮件。",
        "",
        "这个邮箱已获邀加入 KeepEssence 内测，所以收到这封邮件。如果不是你本人，忽略即可。有问题请写信到 help@example.com。",
        "",
      ].join("\n"),
    );
    expect(renderInviteMail("en", CX).subject).toBe("You're in: KeepEssence");
    expect(renderInviteMail("en", CX).text).toBe(
      [
        "You can start using KeepEssence.",
        "",
        "Save what you want to read. The built-in assistant reads it first and tells you what's worth your time. What you keep is up to you.",
        "",
        "Next:",
        "1. Open app.test in a browser on your computer or phone. On Today, press “Save from clipboard” at the bottom to save a link, text or picture you copied; to type instead, press the round button beside it. After 21:00 each evening, read your Daily digest.",
        "2. Sign-in codes come from login@example.com; if one doesn't arrive, check your spam folder.",
        "",
        "You're receiving this because this email address has been invited to the KeepEssence beta. If that isn't you, you can ignore this email. Questions: help@example.com.",
        "",
      ].join("\n"),
    );
  });

  it("the contact sentence is there when a contact address is configured and wholly absent when it is not, in both languages, in the text and in the HTML", () => {
    const withContact = { ...CX, contact: "help@example.com" };
    const without = { ...CX, contact: undefined };
    for (const lang of ["zh", "en"] as const) {
      const set = renderInviteMail(lang, withContact);
      expect(set.text).toContain(lang === "zh" ? "有问题请写信到 help@example.com。" : "Questions: help@example.com.");
      expect(set.html).toContain('<a href="mailto:help@example.com"');
      const unset = renderInviteMail(lang, without);
      expect(unset.text).not.toMatch(/有问题|写信|Questions|mailto|@example\.com\./);
      expect(unset.html).not.toMatch(/有问题|写信|Questions|mailto/);
      // The reason for the mail stays either way.
      expect(unset.text).toContain(lang === "zh" ? "这个邮箱已获邀加入 KeepEssence 内测，所以收到这封邮件。如果不是你本人，忽略即可。" : "You're receiving this because this email address has been invited to the KeepEssence beta. If that isn't you, you can ignore this email.");
    }
    // The deployment's own settings decide it: an empty MAIL_CONTACT is "not configured", and nothing is defaulted in.
    expect(renderInviteMail("en", mailContext({ APP_ORIGIN: "https://app.test", EMAIL_FROM: "A <a@b.co>", MAIL_CONTACT: "" })).text).not.toMatch(/Questions|info@/);
    expect(renderInviteMail("en", mailContext({ APP_ORIGIN: "https://app.test", EMAIL_FROM: "A <a@b.co>" })).text).not.toMatch(/Questions|info@/);
  });

  it("the sender named in the mail is the runtime EMAIL_FROM, never a default; without one the sentence says no address", () => {
    expect(renderInviteMail("en", mailContext({ APP_ORIGIN: "https://app.test", EMAIL_FROM: "Hello <hello@elsewhere.test>" })).text).toContain("Sign-in codes come from hello@elsewhere.test;");
    for (const lang of ["zh", "en"] as const) {
      const text = renderInviteMail(lang, mailContext({ APP_ORIGIN: "https://app.test" })).text;
      expect(text).not.toMatch(/@|login@|keepessence\.app/);
    }
    expect(renderInviteMail("zh", { origin: "https://app.test" }).text).toContain("2. 没收到登录验证码请看一下垃圾邮件。");
  });

  it("the retired wording is nowhere: no box at the top of Today, no website sign-up, no thanks for waiting", () => {
    const retired = /顶部的框|top of Today|在官网申请|申请了内测|感谢你的等待|thank.{0,12}wait|waitlist|waiting list|候补|粘贴到/i;
    for (const lang of ["zh", "en"] as const) {
      for (const cx of [CX, {}]) {
        const m = renderInviteMail(lang, cx);
        expect(m.subject + m.text + m.html).not.toMatch(retired);
      }
    }
  });

  it("the sign-in code mail reads as the spec says, in Chinese and in English, as text", () => {
    expect(renderSigninMail("zh", "482915", 10, CX).subject).toBe("你的 KeepEssence 登录验证码");
    expect(renderSigninMail("zh", "482915", 10, CX).text).toBe(
      ["在登录页输入这个验证码：", "", "482915", "", "验证码 10 分钟内有效，只能用一次。", "如果不是你本人在登录，忽略这封邮件即可。", ""].join("\n"),
    );
    expect(renderSigninMail("en", "482915", 10, CX).subject).toBe("Your KeepEssence sign-in code");
    expect(renderSigninMail("en", "482915", 10, CX).text).toBe(
      ["Enter this code on the sign-in page:", "", "482915", "", "This code works once and expires in 10 minutes.", "If you did not try to sign in, ignore this email.", ""].join("\n"),
    );
  });

  it("the code is in neither the subject, nor the first line of either part, nor the hidden preview text; the validity is the real number", () => {
    for (const lang of ["zh", "en"] as const) {
      const m = renderSigninMail(lang, "482915", 7, CX);
      expect(m.subject).not.toContain("482915");
      expect(m.text.split("\n")[0]).not.toContain("482915");
      const preview = m.html.match(/<div style="display:none[^>]*>([^<]*)<\/div>/)![1];
      expect(preview).not.toContain("482915");
      expect(preview.length).toBeGreaterThan(300); // padded, so a mail list does not go on to show the code beside the subject
      // The first visible text after the preview text is the lead line, not the code.
      expect(m.html.indexOf("482915")).toBeGreaterThan(m.html.indexOf(m.text.split("\n")[0]));
      expect(m.text).toContain(lang === "zh" ? "验证码 7 分钟内有效" : "expires in 7 minutes");
      expect(m.html).toContain("482915");
    }
  });

  it("the invitation mail carries no code and the sign-in mail's validity follows the contract's limit", async () => {
    expect(renderInviteMail("en", CX).text).not.toMatch(/\b\d{6}\b/);
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await call(env, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com", lang: "en" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].body.text).toContain(`expires in ${LIMITS.login_code_minutes} minutes`);
  });

  it("what the deployment does not tell the mail is left out, never invented", () => {
    const bare = renderInviteMail("zh", {});
    expect(bare.text).not.toMatch(/@|app\.test|keepessence\.app|有问题/);
    expect(bare.text).toContain("1. 用电脑或手机浏览器打开 KeepEssence，在「今天」点底部的「从剪贴板存入」");
    expect(bare.text).toContain("2. 没收到登录验证码请看一下垃圾邮件。");
    expect(bare.html).not.toContain("<img");
    expect(bare.html).toContain(MAIL_BRAND.logoAlt.zh); // the name still heads the mail, as text
    const en = renderInviteMail("en", { origin: "https://app.test" });
    expect(en.text).not.toMatch(/Questions|@/);
    expect(en.text).toContain("2. If a sign-in code doesn't arrive, check your spam folder.");
  });

  it("the deployment's settings become the mail's context only when they are usable", () => {
    expect(bareAddress("KeepEssence <login@keepessence.app>")).toBe("login@keepessence.app");
    expect(bareAddress("login@keepessence.app")).toBe("login@keepessence.app");
    expect(bareAddress("Sign in <not an address>")).toBeUndefined();
    expect(bareAddress(undefined)).toBeUndefined();
    expect(mailContext({ APP_ORIGIN: "https://app.test/", EMAIL_FROM: "A <a@b.co>", MAIL_CONTACT: " info@b.co " })).toEqual({ origin: "https://app.test", sender: "a@b.co", contact: "info@b.co" });
    expect(mailContext({ APP_ORIGIN: "javascript:alert(1)", MAIL_CONTACT: 'x"><b@b.co' })).toEqual({ origin: undefined, sender: undefined, contact: undefined });
    expect(mailContext({ MAIL_CONTACT: "" }).contact).toBeUndefined();
    expect(mailContext({ PUBLIC_ORIGIN: "https://public.test", APP_ORIGIN: "https://app.test" }).origin).toBe("https://public.test");
  });

  it("the HTML is inline-styled, light only, has the official lockup as its only image and no other remote resource, no gold or red outside the logo", () => {
    for (const make of [() => renderInviteMail("zh", CX), () => renderInviteMail("en", CX), () => renderSigninMail("zh", "482915", 10, CX), () => renderSigninMail("en", "482915", 10, CX)]) {
      const { html } = make();
      const lang = html.match(/<html lang="(zh|en)"/)![1];
      const images = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
      expect(images).toHaveLength(1);
      expect(images[0]).toContain(`src="https://app.test/brand/lockup-${lang}-black.png"`);
      expect(images[0]).toContain(`alt="${lang === "zh" ? "精华" : "Keep Essence"}"`);
      expect(images[0]).toContain('height="32"');
      expect(images[0]).toContain(lang === "zh" ? 'width="73"' : 'width="137"');
      // No resource beyond that one image: no sheet, script, font, import, background image, no svg.
      expect(html).not.toMatch(/<link|<script|<style|@import|url\(|<svg|\.svg|background-image|<iframe|<form/i);
      expect([...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1])).toHaveLength(1);
      // Links are plain addresses: the sign-in address or the contact's mailto.
      for (const m of html.matchAll(/href="([^"]*)"/g)) expect(["https://app.test", "mailto:help@example.com"]).toContain(m[1]);
      expect(html).toContain('<meta name="color-scheme" content="light">');
      expect(html).toMatch(/max-width:600px/);
      // Colours are the light tokens of design/tokens.css and nothing else; gold (#C5A229) and red (#B3261E) are not among them.
      const allowed = new Set(["#F9F6F4", "#FFFDFC", "#D7D1CF", "#252321", "#45403D", "#605B59", "#EEECEC"]);
      for (const hex of html.match(/#[0-9a-fA-F]{6}\b/g) ?? []) expect(allowed.has(hex.toUpperCase())).toBe(true);
    }
  });

  it("the two mails share one header, and the same words go into the text and the HTML", () => {
    for (const lang of ["zh", "en"] as const) {
      const header = (html: string) => html.match(/<tr><td style="padding:20px 28px;[^>]*>(.*?)<\/td><\/tr>/)![1];
      expect(header(renderInviteMail(lang, CX).html)).toBe(header(renderSigninMail(lang, "482915", 10, CX).html));
      const invite = renderInviteMail(lang, CX);
      const visible = invite.html
        .replace(/<div style="display:none.*?<\/div>/, "")
        .replace(/<\/(p|td|tr)>/g, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ");
      for (const line of invite.text.split("\n").filter(Boolean)) expect(visible).toContain(line.replace(/^\d\. /, "").replace(/\s+/g, " ").trim());
    }
  });

  it("HTML-escapes whatever it is given", () => {
    const m = renderInviteMail("en", { origin: "https://app.test/?a=1&b=2", sender: "a@b.co", contact: "o'neil@b.co" });
    expect(m.html).toContain("https://app.test/?a=1&amp;b=2");
    expect(m.html).toContain("o&#39;neil@b.co");
  });

  it("uses only the words of the glossary: none of the words the interface does not use", () => {
    const banned = /书签|bookmark|知识库|knowledge base|存档|archive|搜索|search|分类|categor|文件夹|folder|主题|topic|喜欢|\blike\b|首页|\bhome\b|设置|settings|token|api key|转写|转录|语音转文字|暂存|整理|蜜蜂|\bbee\b|nectar|花蜜/i;
    for (const lang of ["zh", "en"] as const) {
      for (const m of [renderInviteMail(lang, CX), renderSigninMail(lang, "482915", 10, CX)]) {
        // "spam folder" is the reader's own mail app (Project's ruling 7217448713 keeps Market's sentence), not a folder in the product.
        const text = (m.subject + "\n" + m.text).replace(/spam folder/g, "spam");
        expect(text).not.toMatch(banned);
      }
    }
  });

  it("the button names in the mail are the web app's own words, and the digest is the Daily digest", () => {
    // From web main 9b57026 (src/i18n zh.ts / en.ts: inbox.paste, nav.digest), also found in the live bundle on 2026-11-27.
    expect(renderInviteMail("zh", CX).text).toContain("「从剪贴板存入」");
    expect(renderInviteMail("zh", CX).text).toContain("「每日摘要」");
    expect(renderInviteMail("en", CX).text).toContain("“Save from clipboard”");
    expect(renderInviteMail("en", CX).text).toContain("Daily digest");
  });

  it("a reason stored for the operator holds no address and no 6-digit number", () => {
    expect(safeWhy("422 {\"to\":\"ann@example.com\",\"text\":\"code 123456 now\"}")).not.toMatch(/ann@|example\.com|\d{6}/);
    // An echoed body is JSON-escaped: the code sits right after an "n" (\n482915\n), where a word boundary would miss it.
    expect(safeWhy('{"message":"x\\n482915\\ny"}')).not.toContain("482915");
    expect(safeWhy("status 422 and 7 tries")).toBe("status 422 and 7 tries");
    expect(safeWhy("x".repeat(500))).toHaveLength(120);
  });
});

// ---------------------------------------------------------------- inviting queues one mail; the Cron sends it once

describe("#106 the invitation notice", () => {
  it("inviting only queues: nothing is sent in the invite request, and each address keeps the language it was given", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    const r = await admin(env, "POST", "/admin/invites", { emails: ["ann@example.com", "bob@example.com", "cy@example.com"], langs: { "Ann@Example.com": "zh" }, lang: "en" });
    expect(r.status).toBe(201);
    expect(r.json.added).toEqual(["ann@example.com", "bob@example.com", "cy@example.com"]);
    expect(sent).toHaveLength(0);
    // Each invitation has its own identity, made when it is made.
    const ids = (await db(env, "SELECT invite_id FROM invites")).map((x) => x.invite_id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => /^inv_[0-9a-f]{24}$/.test(id))).toBe(true);
    expect((await db(env, "SELECT email, lang, invite_mail_state AS state FROM invites ORDER BY email")).map((x) => [x.email, x.lang, x.state])).toEqual([
      ["ann@example.com", "zh", "queued"],
      ["bob@example.com", "en", "queued"],
      ["cy@example.com", "en", "queued"],
    ]);
    const list = await invites(env);
    expect(list.every((i) => i.mail.state === "queued" && i.mail.reason === null)).toBe(true);
    expect(list.find((i) => i.email === "ann@example.com").lang).toBe("zh");
  });

  it("the Cron sends each queued invitation once, in its language, as HTML and text, from the configured sender, and records it as accepted", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { emails: ["ann@example.com", "bob@example.com"], langs: { "ann@example.com": "zh" } });
    advance(MINUTE);
    await runMinute(env);
    expect(sent).toHaveLength(2);
    const ann = sent.find((s) => s.body.to[0] === "ann@example.com")!;
    expect(ann.url).toBe("https://api.resend.com/emails");
    expect(ann.body.from).toBe("KeepEssence <login@example.com>");
    expect(ann.body.subject).toBe("你可以开始用 KeepEssence 了");
    expect(ann.body.text).toContain("接下来：");
    expect(ann.body.html).toContain('<html lang="zh"');
    expect(ann.body.html).toContain("https://app.test/brand/lockup-zh-black.png");
    const bob = sent.find((s) => s.body.to[0] === "bob@example.com")!;
    expect(bob.body.subject).toBe("You're in: KeepEssence"); // no language given: the core's default
    expect(bob.body.html).toContain("https://app.test/brand/lockup-en-black.png");
    const list = await invites(env);
    expect(list.map((i) => [i.email, i.mail.state, i.mail.reason])).toEqual([["bob@example.com", "accepted", null], ["ann@example.com", "accepted", null]]);
    expect(list[0].mail.at).toBe("2026-11-24T04:01:00.000Z");
    // Another run, and another: nothing more goes out.
    await runMinute(env);
    advance(MINUTE);
    await runMinute(env);
    expect(sent).toHaveLength(2);
  });

  it("inviting an address that is already invited sends nothing, in the same request or later", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    const first = await admin(env, "POST", "/admin/invites", { emails: ["ann@example.com", "Ann@Example.com", " ann@example.com"] });
    expect(first.json.added).toEqual(["ann@example.com"]);
    await runMinute(env);
    expect(sent).toHaveLength(1);
    const again = await admin(env, "POST", "/admin/invites", { email: "ann@example.com", lang: "zh" });
    expect(again.json).toEqual({ email: "ann@example.com", added: [], already: ["ann@example.com"], invalid: [] });
    await runMinute(env);
    expect(sent).toHaveLength(1);
    expect((await stateOf(env, "ann@example.com")).state).toBe("accepted");
    expect((await stateOf(env, "ann@example.com")).lang).toBeNull(); // the second request did not touch the row
  });

  it("two invite requests for the same address at once make one invitation and one mail", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    const results = await Promise.all([1, 2, 3].map(() => admin(env, "POST", "/admin/invites", { email: "ann@example.com" })));
    expect(results.flatMap((r) => r.json.added)).toEqual(["ann@example.com"]);
    await runMinute(env);
    expect(sent.map((s) => s.body.to[0])).toEqual(["ann@example.com"]);
  });

  it("overlapping Cron runs claim each queued invitation once between them", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { emails: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"] });
    const claimed = await Promise.all([sendInviteMails(env), sendInviteMails(env), sendInviteMails(env), runMinute(env)]);
    expect(typeof claimed[0]).toBe("number");
    expect(sent.map((s) => s.body.to[0]).sort()).toEqual(["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
    expect((await invites(env)).every((i) => i.mail.state === "accepted")).toBe(true);
  });

  it("a run sends a few, and a big batch drains over the next minutes, each address once", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    const emails = Array.from({ length: INVITE_MAILS_PER_RUN * 2 + 5 }, (_, i) => `p${String(i).padStart(2, "0")}@example.com`);
    await admin(env, "POST", "/admin/invites", { emails });
    expect(await sendInviteMails(env)).toBe(INVITE_MAILS_PER_RUN);
    expect(sent).toHaveLength(INVITE_MAILS_PER_RUN);
    expect(await sendInviteMails(env)).toBe(INVITE_MAILS_PER_RUN);
    expect(await sendInviteMails(env)).toBe(5);
    expect(await sendInviteMails(env)).toBe(0);
    expect(sent.map((s) => s.body.to[0]).sort()).toEqual(emails);
  });

  it("a refusal (a 4xx) is failed / refused: the provider's words are not stored, the log gets them without address or number, and the mail is never sent again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent, (s) => Response.json({ message: `bad to ${s.body.to[0]} code 123456` }, { status: 422 })) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await runMinute(env);
    expect(await stateOf(env, "ann@example.com")).toEqual({ state: "failed", reason: "refused", lang: null });
    const stored = JSON.stringify(await db(env, "SELECT * FROM invites"));
    expect(stored).not.toMatch(/bad to|123456/);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("invitation mail refused");
    expect(logged).toContain("422");
    expect(logged).not.toMatch(/ann@|123456/);
    for (let i = 0; i < 3; i++) {
      advance(MINUTE);
      await runMinute(env);
    }
    expect(sent).toHaveLength(1);
    expect((await invites(env))[0].mail).toEqual({ state: "failed", at: "2026-11-24T04:00:00.000Z", reason: "refused" });
  });

  it("which answers are a refusal and which are unconfirmed: a 4xx says no; a 5xx and a redirect are not a clear answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: Array<[string, () => Response, string]> = [
      ["a@example.com", () => new Response("no", { status: 400 }), "refused"],
      ["b@example.com", () => new Response("no", { status: 403 }), "refused"],
      ["c@example.com", () => new Response("slow down", { status: 429 }), "refused"],
      ["d@example.com", () => new Response("oops", { status: 500 }), "unconfirmed"],
      ["e@example.com", () => new Response("down", { status: 503 }), "unconfirmed"],
      ["f@example.com", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }), "unconfirmed"],
    ];
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent, (s) => cases.find(([to]) => to === s.body.to[0])![1]()) });
    await admin(env, "POST", "/admin/invites", { emails: cases.map(([to]) => to) });
    await runMinute(env);
    for (const [to, , reason] of cases) expect(await stateOf(env, to)).toMatchObject({ state: "failed", reason });
    expect(sent).toHaveLength(cases.length);
    // Neither kind is asked again, however many minutes go by.
    for (let i = 0; i < 3; i++) {
      advance(MINUTE);
      await runMinute(env);
    }
    expect(sent).toHaveLength(cases.length);
    for (const [to, , reason] of cases) expect(await stateOf(env, to)).toMatchObject({ state: "failed", reason });
  });

  it("a send call that does not answer in time is unconfirmed and is aborted; the cut-off of a sending invitation is far above one call's timeout", async () => {
    let aborted = false;
    const env = makeEnv({
      ...MAIL,
      OUTBOUND: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const mail = { to: "ann@example.com", subject: "s", text: "t", html: "h" };
    expect(await sendMail(env, mail, 20)).toMatchObject({ outcome: "unconfirmed", why: "timed out" });
    expect(aborted).toBe(true);
    const binding = makeEnv({ EMAIL_FROM: "A <a@b.co>", EMAIL: { send: () => new Promise(() => {}) } });
    expect(await sendMail(binding, mail, 20)).toMatchObject({ outcome: "unconfirmed", why: "timed out" });
    expect(SENDING_UNCONFIRMED_AFTER).toBeGreaterThan(SEND_TIMEOUT_MS * 10);
  });

  it("a mail that breaks before it is handed to the provider is failed / error: nothing was sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    // A broken setting (not a string) makes the mail's own preparation throw, before any request exists.
    await runMinute(makeEnv({ ...MAIL, APP_ORIGIN: 42 as any, OUTBOUND: resend(sent) }));
    expect(sent).toHaveLength(0);
    expect(await stateOf(env, "ann@example.com")).toMatchObject({ state: "failed", reason: "error" });
  });

  it("the platform's mail binding is used the same way, with HTML and text; a binding that throws is unconfirmed", async () => {
    const got: any[] = [];
    const env = makeEnv({ EMAIL_FROM: "KeepEssence <login@example.com>", EMAIL: { send: async (m: any) => void got.push(m) } });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com", lang: "zh" });
    await runMinute(env);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ to: "ann@example.com", from: "KeepEssence <login@example.com>", subject: "你可以开始用 KeepEssence 了" });
    expect(got[0].text).toContain("接下来：");
    expect(got[0].html).toContain("<html lang=\"zh\"");

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = makeEnv({ EMAIL_FROM: "KeepEssence <login@example.com>", EMAIL: { send: async () => { throw new Error("refused for bob@example.com"); } } });
    await admin(broken, "POST", "/admin/invites", { email: "bob@example.com" });
    await runMinute(broken);
    // A call that threw is not a known refusal: the binding may or may not have the mail.
    expect(await stateOf(broken, "bob@example.com")).toMatchObject({ state: "failed", reason: "unconfirmed" });
  });

  it("a connection cut during the send is failed / unconfirmed, and the mail is not sent again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const env = makeEnv({
      ...MAIL,
      OUTBOUND: async (url, init) => {
        sent.push({ url, body: JSON.parse(String(init?.body)) });
        throw new TypeError("Network connection lost while sending to ann@example.com");
      },
    });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await runMinute(env);
    expect(await stateOf(env, "ann@example.com")).toEqual({ state: "failed", reason: "unconfirmed", lang: null });
    for (let i = 0; i < 3; i++) {
      advance(20 * MINUTE);
      await runMinute(env);
    }
    expect(sent).toHaveLength(1);
    expect((await invites(env))[0].mail).toMatchObject({ state: "failed", reason: "unconfirmed" });
  });

  it("when the provider took the mail but the answer could not be written, the invitation stays sending, is not claimed again, and ends failed / unconfirmed without a second request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Sent[] = [];
    const healthy = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    // The same database, except that writing the answer fails (the claim itself went through).
    const real = healthy.DB;
    const flaky = {
      ...healthy,
      DB: new Proxy(real, {
        get(target, prop) {
          if (prop === "prepare")
            return (sql: string) =>
              /SET invite_mail_state = \?2/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("D1 unavailable"); } }) } : target.prepare(sql);
          const value = (target as any)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as typeof healthy;
    await admin(healthy, "POST", "/admin/invites", { email: "ann@example.com" });
    await runMinute(flaky);
    expect(sent).toHaveLength(1); // the provider has it
    expect((await stateOf(healthy, "ann@example.com")).state).toBe("sending");
    await runMinute(healthy);
    expect(sent).toHaveLength(1);
    advance(SENDING_UNCONFIRMED_AFTER - 1000);
    await runMinute(healthy);
    expect((await stateOf(healthy, "ann@example.com")).state).toBe("sending");
    advance(2000);
    await runMinute(healthy);
    expect(await stateOf(healthy, "ann@example.com")).toMatchObject({ state: "failed", reason: "unconfirmed" });
    for (let i = 0; i < 3; i++) {
      advance(MINUTE);
      await runMinute(healthy);
    }
    expect(sent).toHaveLength(1);
  });

  it("each invitation has its own id, which is also the provider's idempotency key; a re-issued invitation has a new one; no address is in it", async () => {
    const sent: Array<{ key: string | undefined; to: string }> = [];
    const env = makeEnv({
      ...MAIL,
      OUTBOUND: async (_url, init) => {
        sent.push({ key: (init?.headers as Record<string, string>)["idempotency-key"], to: JSON.parse(String(init?.body)).to[0] });
        return Response.json({ id: "x" });
      },
    });
    await admin(env, "POST", "/admin/invites", { emails: ["ann@example.com", "bob@example.com"] });
    await runMinute(env);
    const first = await db(env, "SELECT email, invite_id FROM invites ORDER BY email");
    await admin(env, "DELETE", "/admin/invites", { email: "ann@example.com" });
    advance(MINUTE);
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await runMinute(env);
    expect(sent.map((s) => s.to)).toEqual(["ann@example.com", "bob@example.com", "ann@example.com"]);
    const keys = sent.map((s) => s.key!);
    for (const key of keys) {
      expect(key).toMatch(/^inv_[0-9a-f]{24}$/);
      expect(key).not.toContain("example");
    }
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(first.find((r) => r.email === "ann@example.com").invite_id);
    expect(keys[1]).toBe(first.find((r) => r.email === "bob@example.com").invite_id);
    expect(keys[2]).toBe((await db(env, "SELECT invite_id FROM invites WHERE email = 'ann@example.com'"))[0].invite_id);
    // The sign-in code mail carries no such key: its tries are the person's own.
    const code: Array<string | undefined> = [];
    const env2 = makeEnv({ ...MAIL, OUTBOUND: async (_u, init) => { code.push((init?.headers as Record<string, string>)["idempotency-key"]); return Response.json({ id: "y" }); } });
    await call(env2, "POST", "/v1/auth/email-codes", { body: { email: "bob@example.com" } });
    expect(code).toEqual([undefined]);
  });

  it("a provider that sends the headers and never finishes the body cannot hold the call: the whole exchange has one deadline, and the result is unconfirmed", async () => {
    const stalled = (status: number) => () => new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("partial")) /* never closes */ }), { status });
    const mail = { to: "ann@example.com", subject: "s", text: "t", html: "h" };
    for (const status of [503, 422, 302]) {
      const env = makeEnv({ ...MAIL, OUTBOUND: async () => stalled(status)() });
      const began = Date.now();
      expect(await sendMail(env, mail, 60)).toMatchObject({ outcome: "unconfirmed", why: "timed out" });
      expect(Date.now() - began).toBeLessThan(2000);
    }
    // A plain yes whose body never ends is still a yes: the body is dropped, not waited for.
    const yes = makeEnv({ ...MAIL, OUTBOUND: async () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) }), { status: 200 }) });
    expect(await sendMail(yes, mail, 500)).toEqual({ outcome: "accepted" });
  });

  it("an error body is read for the log only, and only the first few hundred bytes of it", async () => {
    let pulls = 0;
    const endless = () =>
      new Response(new ReadableStream({ pull: (c) => { pulls++; c.enqueue(new TextEncoder().encode("x".repeat(100))); } }), { status: 500 });
    const env = makeEnv({ ...MAIL, OUTBOUND: async () => endless() });
    const result = await sendMail(env, { to: "ann@example.com", subject: "s", text: "t", html: "h" }, 2000);
    expect(result).toMatchObject({ outcome: "unconfirmed" });
    expect((result as { why: string }).why.length).toBeLessThanOrEqual(120);
    expect(pulls).toBeLessThan(40); // stopped near 512 bytes, not after reading everything
  });

  it("a stalled answer for one invitation does not hold up the next in the same run: it is unconfirmed, the other goes out, and neither is asked again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const env = makeEnv({
      ...MAIL,
      OUTBOUND: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        sent.push({ url, body });
        if (body.to[0] === "a-stalls@example.com") return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("partial")) }), { status: 503 });
        return Response.json({ id: "x" });
      },
    });
    await admin(env, "POST", "/admin/invites", { emails: ["a-stalls@example.com", "b-fine@example.com"] });
    await sendInviteMails(env, 60);
    expect(await stateOf(env, "a-stalls@example.com")).toMatchObject({ state: "failed", reason: "unconfirmed" });
    expect(await stateOf(env, "b-fine@example.com")).toMatchObject({ state: "accepted", reason: null });
    for (let i = 0; i < 3; i++) {
      advance(MINUTE);
      await runMinute(env);
    }
    expect(sent.map((s) => s.body.to[0])).toEqual(["a-stalls@example.com", "b-fine@example.com"]);
  });

  it("a send that times out through the queue is unconfirmed, the call is aborted, and later Cron runs do not ask again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let asked = 0;
    let aborted = false;
    const env = makeEnv({
      ...MAIL,
      OUTBOUND: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          asked++;
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await sendInviteMails(env, 40);
    expect(aborted).toBe(true);
    expect(await stateOf(env, "ann@example.com")).toMatchObject({ state: "failed", reason: "unconfirmed" });
    for (let i = 0; i < 3; i++) {
      advance(20 * MINUTE);
      await runMinute(env);
    }
    expect(asked).toBe(1);
  });

  it("a late result for an invitation that was already settled as unconfirmed is dropped, accepted or refused alike", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    let env: any;
    env = makeEnv({
      ...MAIL,
      OUTBOUND: resend(sent, async (s) => {
        // While this request is in flight, 15 minutes pass and another run settles the invitation as unconfirmed.
        advance(SENDING_UNCONFIRMED_AFTER + 1000);
        await settleInviteMails(env);
        return s.body.to[0] === "ann@example.com" ? Response.json({ id: "x" }) : new Response("no", { status: 422 });
      }),
    });
    for (const email of ["ann@example.com", "bob@example.com"]) {
      await admin(env, "POST", "/admin/invites", { email });
      await sendInviteMails(env);
      expect(await stateOf(env, email)).toMatchObject({ state: "failed", reason: "unconfirmed" }); // neither the late "accepted" nor the late "refused" changed it
    }
    expect(sent.map((s) => s.body.to[0])).toEqual(["ann@example.com", "bob@example.com"]);
  });

  it("with no mail service the invitation is recorded as not sent, and configuring one later does not send it", async () => {
    const sent: Sent[] = [];
    const quiet = makeEnv({ OUTBOUND: resend(sent) });
    await admin(quiet, "POST", "/admin/invites", { email: "ann@example.com" });
    expect(await stateOf(quiet, "ann@example.com")).toMatchObject({ state: "not_sent", reason: "no_mail_service" });
    const configured = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    advance(MINUTE);
    await runMinute(configured);
    expect(sent).toHaveLength(0);
    expect(await stateOf(configured, "ann@example.com")).toMatchObject({ state: "not_sent" });
    // The operator still hands the code out, as before.
    expect((await admin(configured, "POST", "/admin/login-codes", { email: "ann@example.com" })).status).toBe(201);
  });

  it("an invitation queued while mail was configured is closed as not sent when mail no longer is, and is not sent when it comes back", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await runMinute(makeEnv({ OUTBOUND: resend(sent) })); // mail switched off
    expect(await stateOf(env, "ann@example.com")).toMatchObject({ state: "not_sent", reason: "no_mail_service" });
    await runMinute(env); // and back on
    expect(sent).toHaveLength(0);
  });

  it("invitations from before the notice mail existed are never mailed and show no mail state", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await db(env, "INSERT INTO invites (email, created_at) VALUES ('old@example.com', ?)", Date.UTC(2026, 10, 20));
    await runMinute(env);
    await runMinute(env);
    expect(sent).toHaveLength(0);
    expect((await invites(env))[0]).toEqual({ email: "old@example.com", invited_at: "2026-11-20T00:00:00.000Z", joined_at: null, user_id: null, lang: null, mail: null });
  });

  it("an invitation withdrawn before the Cron is never mailed; inviting again is a new invitation and gets one mail", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    expect((await admin(env, "DELETE", "/admin/invites", { email: "ann@example.com" })).status).toBe(204);
    await runMinute(env);
    expect(sent).toHaveLength(0);
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com", lang: "zh" });
    await runMinute(env);
    expect(sent.map((s) => s.body.to[0])).toEqual(["ann@example.com"]);
    expect(sent[0].body.subject).toBe("你可以开始用 KeepEssence 了");
  });

  it("a result that arrives after the invitation was withdrawn and issued again does not overwrite the new invitation", async () => {
    const sent: Sent[] = [];
    let env: any;
    env = makeEnv({
      ...MAIL,
      OUTBOUND: resend(sent, async () => {
        if (sent.length === 1) {
          await admin(env, "DELETE", "/admin/invites", { email: "ann@example.com" });
          await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
        }
        return Response.json({ id: "x" });
      }),
    });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await sendInviteMails(env);
    expect(sent).toHaveLength(1);
    expect((await stateOf(env, "ann@example.com")).state).toBe("queued"); // the new invitation is still waiting for its own mail
    advance(MINUTE);
    await sendInviteMails(env);
    expect(sent).toHaveLength(2);
    expect((await stateOf(env, "ann@example.com")).state).toBe("accepted");
  });

  it("a late result for an old invitation (accepted or refused) is dropped, even when the new invitation of the same address is already sending: results are written by invitation id, not by address", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sent: Sent[] = [];
    const newIds: Record<string, string> = {};
    let env: any;
    env = makeEnv({
      ...MAIL,
      OUTBOUND: resend(sent, async (s) => {
        const email = s.body.to[0];
        // While the old invitation's request is in flight: withdrawn, invited again, and that new invitation is claimed (sending) by another run.
        await admin(env, "DELETE", "/admin/invites", { email });
        await admin(env, "POST", "/admin/invites", { email });
        await db(env, "UPDATE invites SET invite_mail_state = 'sending', invite_mail_at = ? WHERE email = ?", Date.UTC(2026, 10, 24, 4, 0, 0), email);
        newIds[email] = (await db(env, "SELECT invite_id FROM invites WHERE email = ?", email))[0].invite_id;
        // The old invitation's result arrives now: a yes for ann, a no for bob.
        return email === "ann@example.com" ? Response.json({ id: "x" }) : new Response("no", { status: 422 });
      }),
    });
    for (const email of ["ann@example.com", "bob@example.com"]) {
      await admin(env, "POST", "/admin/invites", { email });
      const oldId = (await db(env, "SELECT invite_id FROM invites WHERE email = ?", email))[0].invite_id;
      await sendInviteMails(env);
      expect(newIds[email]).not.toBe(oldId);
      const row = (await db(env, "SELECT invite_id, invite_mail_state AS state, invite_mail_reason AS reason FROM invites WHERE email = ?", email))[0];
      expect(row).toEqual({ invite_id: newIds[email], state: "sending", reason: null }); // the old result neither overwrote it nor decided it
    }
    expect(sent).toHaveLength(2);
  });

  it("a send cut off before its result was written is not claimed again, and after 15 minutes it is recorded as failed / unconfirmed, not resent", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await db(env, "UPDATE invites SET invite_mail_state = 'sending', invite_mail_at = ?", Date.UTC(2026, 10, 24, 4, 0, 0));
    advance(SENDING_UNCONFIRMED_AFTER - 1000);
    await runMinute(env);
    expect(sent).toHaveLength(0);
    expect((await stateOf(env, "ann@example.com")).state).toBe("sending");
    advance(2000);
    await runMinute(env);
    expect(sent).toHaveLength(0);
    expect(await stateOf(env, "ann@example.com")).toMatchObject({ state: "failed", reason: "unconfirmed" });
    advance(MINUTE);
    await runMinute(env);
    expect(sent).toHaveLength(0);
  });

  it("unknown or malformed languages are ignored, and the core's default (English) is used", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { emails: ["ann@example.com", "bob@example.com"], lang: "fr", langs: { "ann@example.com": 3, "bob@example.com": "xx" } });
    await runMinute(env);
    expect(sent.map((s) => s.body.subject)).toEqual(["You're in: KeepEssence", "You're in: KeepEssence"]);
    const list = await admin(env, "POST", "/admin/invites", { emails: ["cy@example.com"], langs: ["zh"] });
    expect(list.status).toBe(201);
    expect((await stateOf(env, "cy@example.com")).lang).toBeNull();
  });

  it("an invite request without the operator's key changes nothing and queues nothing", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    for (const token of [null, "wrong"]) {
      const r = await call(env, "POST", "/admin/invites", { token, body: { email: "ann@example.com" } });
      expect([401, 404]).toContain(r.status);
    }
    await runMinute(env);
    expect(await db(env, "SELECT email FROM invites")).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("the migration only adds nullable columns and an index to invites", async () => {
    const env = makeEnv();
    const cols = await db(env, "SELECT name, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('invites')");
    const added = cols.filter((c) => ["invite_id", "lang", "invite_mail_state", "invite_mail_at", "invite_mail_reason"].includes(c.name));
    expect(added.map((c) => c.name).sort()).toEqual(["invite_id", "invite_mail_at", "invite_mail_reason", "invite_mail_state", "lang"]);
    expect(added.every((c) => c.nn === 0 && c.d === "NULL")).toBe(true);
    expect((await db(env, "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('invites_mail_queue', 'invites_invite_id') ORDER BY name")).map((i) => i.name)).toEqual(["invites_invite_id", "invites_mail_queue"]);
  });

  it("the operator's show-once login code is untouched: it still works, shows the code to that call only, and the audit holds the action and the address, never the code", async () => {
    const env = makeEnv(); // no mail service: this is the only way to a code
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    const r = await admin(env, "POST", "/admin/login-codes", { email: "ann@example.com" });
    expect(r.status).toBe(201);
    const code: string = r.json.code;
    expect(code).toMatch(/^\d{6}$/);
    const audit = await admin(env, "GET", "/admin/audit");
    expect(audit.json.entries.map((e: any) => [e.action, e.target, e.detail])).toContainEqual(["login_code.mint", "ann@example.com", ""]);
    const elsewhere = JSON.stringify([audit.json, await invites(env), (await admin(env, "GET", "/admin/overview")).json, await db(env, "SELECT * FROM admin_audit"), await db(env, "SELECT * FROM core_state"), await db(env, "SELECT * FROM invites")]);
    expect(elsewhere).not.toContain(code);
    const session = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code, device_name: "Laptop", client: "web", timezone: "Asia/Shanghai" } });
    expect(session.status).toBe(201);
  });
});

// ---------------------------------------------------------------- the sign-in code mail

describe("#106 the sign-in code mail", () => {
  it("is sent as HTML and text in the language the sign-in page asked for, with the code only in the body", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await call(env, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com", lang: "zh" } });
    const m = sent[0].body;
    expect(m.subject).toBe("你的 KeepEssence 登录验证码");
    const code = m.text.match(/\b\d{6}\b/)![0];
    expect(m.html).toContain(code);
    expect(m.subject).not.toContain(code);
    expect(m.html).toContain("https://app.test/brand/lockup-zh-black.png");
    expect(m.text).toContain(`验证码 ${LIMITS.login_code_minutes} 分钟内有效，只能用一次。`);
    // The code still works.
    const r = await call(env, "POST", "/v1/auth/sessions", { body: { email: "ann@example.com", code, device_name: "Laptop", client: "web", timezone: "Asia/Shanghai" } });
    expect(r.status).toBe(201);
  });

  it("never reaches a log, the operator's overview, the invitation list or the audit log, even when the provider echoes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent, (s) => Response.json({ message: `cannot deliver ${s.body.text} to ${s.body.to[0]}` }, { status: 500 })) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    await call(env, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com", lang: "en" } });
    const code = sent[0].body.text.match(/\b\d{6}\b/)![0];
    const everything = JSON.stringify([
      warn.mock.calls,
      log.mock.calls,
      err.mock.calls,
      (await admin(env, "GET", "/admin/overview")).json,
      await invites(env),
      (await admin(env, "GET", "/admin/audit")).json,
      await db(env, "SELECT * FROM core_state"),
      await db(env, "SELECT * FROM admin_audit"),
    ]);
    expect(everything).not.toContain(code);
    expect(everything).not.toContain("ann@example.com\"," + code);
    expect(warn.mock.calls.length).toBeGreaterThan(0); // the refusal was logged, with its reason only
    const last = (await db(env, "SELECT value FROM core_state WHERE key = 'mail.last'"))[0].value as string;
    expect(last).toMatch(/^failed: 500 /); // a 500 is not a clear "no": the overview's old word for "it did not go" is kept
    expect(last).toContain("<number>");
    expect(last).not.toContain("ann@example.com");
  });

  it("still answers 202 when the mail service fails, and sends nothing to an address that is not invited", async () => {
    const sent: Sent[] = [];
    const env = makeEnv({ ...MAIL, OUTBOUND: resend(sent, () => new Response("down", { status: 503 })) });
    await admin(env, "POST", "/admin/invites", { email: "ann@example.com" });
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "ann@example.com" } })).status).toBe(202);
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "stranger@example.com" } })).status).toBe(202);
    expect(sent.map((s) => s.body.to[0])).toEqual(["ann@example.com"]);
  });
});
