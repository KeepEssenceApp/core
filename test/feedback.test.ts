// Feedback from a user to the operator: stored, listed for the operator, passed on when configured.
import { describe, expect, it } from "vitest";
import { runMinute } from "../src/cron";
import { ADMIN, call, connectDevice, db, makeEnv, signIn, type Outbound } from "./helpers";

const admin = (env: any, path: string) => call(env, "GET", path, { token: ADMIN });
const GH = { FEEDBACK_GITHUB_REPO: "acme/feedback", FEEDBACK_GITHUB_TOKEN: "test-issue-token" };

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

  it("is filed as an issue when a repository is configured, with the sender named; the token goes nowhere else", async () => {
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
    expect(sent[0].body.body).toContain("ann@example.com");
    expect(sent[0].body.body).toContain("Second line.");
    const list = (await admin(env, "/admin/feedback")).json;
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

  it("deleting the account deletes its feedback here", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    await call(env, "POST", "/v1/feedback", { token: ann.token, body: { wrong: "Something." } });
    expect((await call(env, "DELETE", "/v1/account", { token: ann.token, body: { confirm_email: "ann@example.com" } })).status).toBe(204);
    expect(await db(env, "SELECT id FROM feedback")).toHaveLength(0);
  });
});
