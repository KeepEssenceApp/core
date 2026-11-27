// Feedback from a user to the operator: stored, listed for the operator, passed on when configured.
import { describe, expect, it, vi } from "vitest";
import { runMinute } from "../src/cron";
import { ADMIN, call, connectDevice, db, makeEnv, signIn, type Outbound } from "./helpers";

const admin = (env: any, path: string) => call(env, "GET", path, { token: ADMIN });
const GH = { FEEDBACK_GITHUB_REPO: "acme/feedback", FEEDBACK_GITHUB_TOKEN: "test-issue-token" };

// Made-up values only: addresses on reserved domains, numbers from the ranges set aside for
// fiction, and credentials that are not issued by anyone.
const FAKE = {
  email: "jane.doe+qa@example.test",
  email2: "Jane_Doe@Mail.Example.Test",
  phoneUs: "+1 (415) 555-0132",
  phoneCn: "138 0013 8000",
  key: "sk-proj-FAKE0123456789abcdefXYZ",
  gh: "ghp_FAKE0123456789abcdefghijklmnopqr",
  bearer: "Bearer FAKEbearer0123456789token",
  // Put together here so that the source holds nothing a secret scanner takes for a key block.
  pem: ["-----BEGIN", " PRIVATE KEY-----\nMIIFAKEFAKEFAKEFAKE0123456789\n-----END", " PRIVATE KEY-----"].join(""),
};
/** The parts of the samples that must not appear anywhere outside the portal. */
const ORIGINALS = [FAKE.email, FAKE.email2, "jane.doe", "Jane_Doe", FAKE.phoneUs, "(415)", "138 0013 8000", "FAKE0123456789", "FAKEbearer0123456789token", "MIIFAKEFAKE", "BEGIN PRIVATE KEY"];

describe("feedback", () => {
  it("is stored with who sent it and from where, and the operator can read it", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const res = await call(env, "POST", "/v1/feedback", { token: ann.token, body: { doing: "Just signed in.", wrong: "  I do not know where to start.  ", wish: "A guide." } });
    expect(res.status).toBe(201);
    expect(res.json.id).toMatch(/^fb_/);
    const list = (await admin(env, "/admin/feedback")).json;
    expect(list.forwarding).toBeNull();
    expect(list.feedback).toHaveLength(1);
    expect(list.feedback[0]).toMatchObject({ email: "ann@example.com", where: "web", client: "web", doing: "Just signed in.", wrong: "I do not know where to start.", wish: "A guide.", issue_url: null });
  });

  it("any tier may send it; what went wrong is required; unknown fields are refused", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const ext = await connectDevice(env, ann, "save");
    expect((await call(env, "POST", "/v1/feedback", { token: ext.token, body: { wrong: "The popup closes too fast." } })).status).toBe(201);
    expect((await db(env, "SELECT place FROM feedback"))[0].place).toBe("extension");
    expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "   " } })).status).toBe(400);
    expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { doing: "x" } })).status).toBe(400);
    expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "x", email: "someone@example.com" } })).status).toBe(400);
    expect((await call(env, "POST", "/v1/feedback", { body: { wrong: "x" } })).status).toBe(401);
  });

  it("is limited to 20 a day per account", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    for (let i = 0; i < 20; i++) expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: `Thing ${i}` } })).status).toBe(201);
    expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "One too many" } })).status).toBe(429);
  });

  it("is filed as an issue when a repository is configured, without the sender's email; the token goes nowhere else", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (url, init) => {
      sent.push({ url, auth: (init?.headers as any)?.authorization, body: JSON.parse(String(init?.body)) });
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/7" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { where: "ios", wrong: "The share sheet does nothing.\nSecond line." } });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://api.github.com/repos/acme/feedback/issues");
    expect(sent[0].auth).toBe("Bearer test-issue-token");
    expect(sent[0].body.title).toBe("[ios] The share sheet does nothing.");
    expect(sent[0].body.labels).toEqual(["feedback", "in-app"]);
    // The sender is not named: the feedback id links to the portal, where the email is.
    expect(JSON.stringify(sent[0].body)).not.toContain("ann@example.com");
    expect(sent[0].body.body).toContain("Second line.");
    const list = (await admin(env, "/admin/feedback")).json;
    expect(sent[0].body.body).toContain(`feedback id: ${list.feedback[0].id}`);
    expect(list.feedback[0].email).toBe("ann@example.com");
    expect(list.forwarding).toBe("acme/feedback");
    expect(list.feedback[0].issue_url).toBe("https://github.com/acme/feedback/issues/7");
    // Already filed: the minute job does not file it twice.
    await runMinute(env);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("test-issue-token");
  });

  it("a tracker that refuses does not fail the user; the minute job tries again, a few times only", async () => {
    let up = false;
    let asked = 0;
    const outbound: Outbound = async () => {
      asked++;
      return up ? Response.json({ html_url: "https://github.com/acme/feedback/issues/8" }, { status: 201 }) : new Response("no", { status: 503 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    expect((await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "First." } })).status).toBe(201);
    expect((await admin(env, "/admin/feedback")).json.feedback[0]).toMatchObject({ issue_url: null, forward_error: "status 503" });
    up = true;
    await runMinute(env);
    expect((await admin(env, "/admin/feedback")).json.feedback[0].issue_url).toBe("https://github.com/acme/feedback/issues/8");
    // One that never gets through is given up on after five attempts.
    up = false;
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "Second." } });
    for (let i = 0; i < 8; i++) await runMinute(env);
    expect((await db(env, "SELECT forward_attempts FROM feedback WHERE wrong = 'Second.'"))[0].forward_attempts).toBe(5);
    expect(asked).toBe(2 + 5);
  });

  it("what the user typed is masked in the issue: emails, phone numbers and credentials, in all four fields (QA #78)", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/9" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    // Every value below is made up.
    const res = await call(env, "POST", "/v1/feedback", {
      token: ann.token,
      body: {
        where: "web",
        doing: `Signing in as ${FAKE.email} with ${FAKE.key}`,
        wrong: `${FAKE.bearer} was refused; call me on ${FAKE.phoneUs}\nThe page then showed ${FAKE.pem}`,
        wish: `Mail ${FAKE.email2} or ${FAKE.phoneCn}; my GitHub token ${FAKE.gh}`,
      },
    });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    const all = JSON.stringify(sent[0]);
    for (const original of ORIGINALS) expect(all, original).not.toContain(original);
    expect(all).not.toContain("ann@example.com");
    expect(sent[0].title).toBe("[web] [secret] was refused; call me on [phone]");
    // The words around the masks stay, so the report can still be read.
    for (const kept of ["Signing in as", "was refused", "The page then showed", "Mail", "my GitHub token"]) expect(sent[0].body).toContain(kept);
    expect(sent[0].body).toMatch(/Masked in this text: \d+ email, \d+ phone, \d+ secret\./);
    expect(sent[0].body).toContain("feedback id: fb_");
    // The operator still has the originals, in the portal.
    const stored = (await admin(env, "/admin/feedback")).json.feedback[0];
    expect(stored).toMatchObject({ email: "ann@example.com", wrong: expect.stringContaining(FAKE.phoneUs), issue_url: "https://github.com/acme/feedback/issues/9" });
  });

  it("a one-time code typed in any of the four fields is masked in the issue: 'verification code', OTP, 验证码 (QA #78)", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/14" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    // Every code is made up.
    const codes = ["482913", "071 358", "649205", "731904", "205817", "9042-1187"];
    const res = await call(env, "POST", "/v1/feedback", {
      token: ann.token,
      body: {
        where: "web",
        doing: `I asked for a sign-in code and it said 205817 was wrong; the old OTP: 071 358 also failed`,
        wrong: `My verification code is 482913 and the page says it is invalid\n验证码是 649205，填进去还是不行`,
        wish: `登录码 731904 不要让我再输一遍。 Security code: 9042-1187`,
      },
    });
    expect(res.status).toBe(201);
    expect(sent).toHaveLength(1);
    const all = JSON.stringify(sent[0]);
    for (const code of codes) expect(all, code).not.toContain(code);
    expect(sent[0].title).toBe("[web] My verification code is [secret] and the page says it is invalid");
    // The words around the masks stay, and the issue says how many were masked.
    for (const kept of ["verification code", "OTP:", "验证码是", "登录码", "Security code:", "the page says it is invalid"]) expect(sent[0].body).toContain(kept);
    expect(sent[0].body).toMatch(/Masked in this text: 6 secret\./);
    // The operator still has what was typed, in the portal.
    expect((await admin(env, "/admin/feedback")).json.feedback[0].wrong).toContain("482913");
  });

  it("the title is masked before it is shortened, so a cut never leaves a part of a credential", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/10" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: `${"It broke. ".repeat(7)}${FAKE.key} and then ${FAKE.email}` } });
    expect(sent[0].title).not.toContain("sk-");
    expect(sent[0].title).not.toContain(FAKE.key.slice(0, 8));
    expect(sent[0].title.length).toBeLessThanOrEqual("[web] ".length + 80);
    // A first line that is only a credential still gives a title.
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: `${FAKE.gh}\nit does not work` } });
    expect(sent[1].title).toBe("[web] [secret]");
  });

  it("where is not free text: a value that is not a place becomes 'other', and shows nowhere", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/11" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    const res = await call(env, "POST", "/v1/feedback", { token: ann.token, body: { where: FAKE.email, wrong: "Nothing." } });
    // The contract may refuse it outright; if it takes it, it is not passed on.
    if (res.status === 201) {
      expect(JSON.stringify(sent)).not.toContain(FAKE.email);
      expect(sent[0].title).toBe("[other] Nothing.");
    } else expect(res.status).toBe(400);
  });

  it("a failure is recorded as a count and a reason that carry none of the original values; nothing is logged with them either", async () => {
    const logged: string[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
    try {
      let mode: "down" | "echo" | "up" = "echo";
      const outbound: Outbound = async (_url, init) => {
        // A client library that puts what it was given in its error message.
        if (mode === "echo") throw new Error(`could not send ${String(init?.body)} for ${FAKE.email} as ${FAKE.bearer} with test-issue-token; owner ann@example.com`);
        return mode === "down" ? new Response("no", { status: 503 }) : Response.json({ html_url: "https://github.com/acme/feedback/issues/12" }, { status: 201 });
      };
      const env = makeEnv({ ...GH, OUTBOUND: outbound });
      const ann = await signIn(env);
      const res = await call(env, "POST", "/v1/feedback", { token: ann.token, body: { doing: FAKE.email, wrong: `${FAKE.gh} ${FAKE.phoneUs}`, wish: FAKE.pem } });
      expect(res.status).toBe(201);
      const row = (await db(env, "SELECT forward_attempts, forward_error FROM feedback"))[0];
      expect(row.forward_attempts).toBe(1);
      expect(row.forward_error).toMatch(/^could not send /);
      for (const original of [...ORIGINALS, "ann@example.com", "test-issue-token"]) expect(row.forward_error, original).not.toContain(original);
      // The minute job tries again and fails differently: still a count and a reason.
      mode = "down";
      await runMinute(env);
      expect(await db(env, "SELECT forward_attempts, forward_error FROM feedback")).toEqual([{ forward_attempts: 2, forward_error: "status 503" }]);
      mode = "up";
      await runMinute(env);
      expect((await db(env, "SELECT issue_url, forward_error FROM feedback"))[0]).toEqual({ issue_url: "https://github.com/acme/feedback/issues/12", forward_error: null });
      // The operator's list shows the reason too.
      const shown = JSON.stringify((await admin(env, "/admin/feedback")).json);
      expect(shown).not.toContain("test-issue-token");
      for (const line of logged) for (const original of [...ORIGINALS, "ann@example.com"]) expect(line, original).not.toContain(original);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("ordinary feedback is passed on as it was written", async () => {
    const sent: any[] = [];
    const outbound: Outbound = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ html_url: "https://github.com/acme/feedback/issues/13" }, { status: 201 });
    };
    const env = makeEnv({ ...GH, OUTBOUND: outbound });
    const ann = await signIn(env);
    await call(env, "POST", "/v1/feedback", {
      token: ann.token,
      body: { doing: "On 2026-11-26 I saved a link at 18:30 and waited 20 minutes.", wrong: "The Calendar entry disappears.\nIt happens on version 1.2.3 only.", wish: "Keep it visible, please." },
    });
    expect(sent[0].title).toBe("[web] The Calendar entry disappears.");
    expect(sent[0].body).toContain("On 2026-11-26 I saved a link at 18:30 and waited 20 minutes.");
    expect(sent[0].body).toContain("It happens on version 1.2.3 only.");
    expect(sent[0].body).toContain("Keep it visible, please.");
    expect(sent[0].body).not.toContain("Masked in this text");
  });

  it("deleting the account deletes its feedback here", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "Something." } });
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: "ann@example.com" } })).status).toBe(204);
    expect(await db(env, "SELECT id FROM feedback")).toHaveLength(0);
  });
});
