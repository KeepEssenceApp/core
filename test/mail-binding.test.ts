import { describe, expect, it } from "vitest";
import { call, invite, makeEnv } from "./helpers";

describe("K1 sign-in codes by the platform's mail binding", () => {
  it("sends the code through the binding to an invited address, and nothing to others", async () => {
    const sent: { to: string; from: string; subject: string; text: string }[] = [];
    const env = makeEnv({ EMAIL: { send: async (m: any) => void sent.push(m) }, EMAIL_FROM: "Sign in <login@example.com>"});
    await invite(env, "in@example.com");
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "in@example.com", lang: "en" } })).status).toBe(202);
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "out@example.com" } })).status).toBe(202);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toBe("in@example.com");
    expect(sent[0].from).toBe("Sign in <login@example.com>");
    expect(sent[0].text).toMatch(/\b\d{6}\b/);
  });
  it("still answers 202 when the binding throws", async () => {
    const env = makeEnv({ EMAIL: { send: async () => { throw new Error("refused for in@example.com"); } }, EMAIL_FROM: "x@example.com"});
    await invite(env, "in@example.com");
    expect((await call(env, "POST", "/v1/auth/email-codes", { body: { email: "in@example.com" } })).status).toBe(202);
  });
});
