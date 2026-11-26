// What is masked in text a user typed before it leaves for an issue tracker (QA #78): emails, phone
// numbers and anything that looks like a credential, and nothing an ordinary report says.
import { describe, expect, it } from "vitest";
import { foundSentence, redact } from "../src/services/redact";

const masked = (text: string, exact?: string[]) => redact(text, exact).text;

// The samples that look most like the real thing are put together here, so that the source holds
// nothing a secret scanner takes for a credential. Every value is made up.
const KEY_BLOCK = (kind: string, body: string, end = true) => ["-----BEGIN", ` ${kind}-----\n${body}`, end ? `\n-----END ${kind}-----` : ""].join("");
const AWS = ["AKIA", "FAKE0123456789AB"].join("");
const JWT = ["eyJhbGciOiJGQUtFIn0", "eyJzdWIiOiJmYWtlIn0", "ZmFrZXNpZw"].join(".");

describe("redact", () => {
  it("masks email addresses wherever they stand", () => {
    expect(masked("write to jane.doe+qa@example.test now")).toBe("write to [email] now");
    expect(masked("(Jane_Doe@Mail.Example.Test)")).toBe("([email])");
    expect(masked("a@b.co, c@d.org")).toBe("[email], [email]");
    expect(masked("用户 王小明@例子.测试 说")).toBe("用户 [email] 说");
    // Not an address: no domain.
    expect(masked("meet @ noon, tag @team")).toBe("meet @ noon, tag @team");
  });

  it("masks phone numbers in the usual shapes, and not dates, versions or small numbers", () => {
    for (const phone of ["+1 (415) 555-0132", "415-555-0132", "(020) 7946 0958", "+44 20 7946 0958", "138 0013 8000", "13800138000", "+86 138-0013-8000", "555-0132"]) {
      expect(masked(`call ${phone} today`), phone).toBe("call [phone] today");
    }
    for (const plain of ["on 2026-11-26 at 18:30", "26/11/2026", "version 1.2.3", "20 minutes", "3 of 5 items", "item 1234", "about 3200 words", "1.5 s"]) {
      expect(masked(plain), plain).toBe(plain);
    }
  });

  it("masks credentials: prefixed keys, bearer tokens, key blocks, web tokens, and values after a name", () => {
    const cases: Array<[string, string]> = [
      ["key sk-proj-FAKE0123456789abcdefXYZ here", "key [secret] here"],
      ["key sk-ant-api03-FAKE_0123456789-abcdef here", "key [secret] here"],
      ["gh ghp_FAKE0123456789abcdefghijklmnopqr ok", "gh [secret] ok"],
      ["gh github_pat_11FAKE0123456789_abcdefghij ok", "gh [secret] ok"],
      ["slack xoxb-0123456789-FAKEFAKEFAKE ok", "slack [secret] ok"],
      [`aws ${AWS} ok`, "aws [secret] ok"],
      ["Authorization: Bearer FAKEbearer0123456789token", "Authorization: [secret]"],
      ["header was Bearer abc123def456", "header was [secret]"],
      [`jwt ${JWT} ok`, "jwt [secret] ok"],
      ["password: hunter2 and more", "[secret] and more"],
      ["my password = \"correct horse battery\" ok", "my [secret] ok"],
      ["api_key=FAKE0123456789 ok", "[secret] ok"],
      ["Authorization: Basic ZmFrZTpmYWtl", "[secret]"],
      [KEY_BLOCK("PRIVATE KEY", "MIIFAKE0123456789"), "[secret]"],
      [`a cut block ${KEY_BLOCK("RSA PRIVATE KEY", "MIIFAKE0123456789", false)}`, "a cut block [secret]"],
    ];
    for (const [text, want] of cases) expect(masked(text), text).toBe(want);
  });

  it("leaves ordinary words alone, including ones that sit near the names of credentials", () => {
    for (const plain of [
      "the bearer authentication page is blank",
      "I lost my password and could not reset it",
      "the token expired",
      "a task-force of risk-averse people",
      "Sign in with a code sent by email",
      "The Calendar entry disappears.",
    ]) expect(masked(plain), plain).toBe(plain);
  });

  it("masks given values wherever they still occur, whatever case", () => {
    expect(masked("from ANN-AT-HOME and ann-at-home", ["ann-at-home"])).toBe("from [secret] and [secret]");
    // Short values and nothing are not masked: they would match everywhere.
    expect(masked("a b c", ["a", "", undefined as unknown as string])).toBe("a b c");
    // Characters that mean something in a pattern are plain here.
    expect(masked("cost (a+b) is [x]", ["(a+b)"])).toBe("cost [secret] is [x]");
  });

  it("says what it found, and only that", () => {
    const { found } = redact("jane@example.test, 13800138000, sk-FAKE0123456789 and sk-FAKE9876543210");
    expect(found).toEqual({ email: 1, phone: 1, secret: 2 });
    expect(foundSentence(found)).toBe("1 email, 1 phone, 2 secret");
    expect(foundSentence({ email: 0, phone: 0, secret: 0 })).toBe("");
  });
});
