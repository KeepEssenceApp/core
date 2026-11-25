import { describe, expect, it } from "vitest";
import { call, idem, makeEnv, signIn } from "./helpers";

describe("QA #35: the same text saved twice is one item", () => {
  it("QA #35: a repeated text is swallowed like a repeated link, also when only the spacing differs; a different text is saved", async () => {
    const env = makeEnv();
    const ann = await signIn(env);
    const save = (text: string) => call(env, "POST", "/v1/items", { token: ann.token, body: { kind: "text", text }, idem: idem() });
    const first = await save("Mixed language test 混合语言测试. Please review the report.");
    expect(first.status).toBe(201);
    const again = await save("Mixed language test 混合语言测试.  Please review\nthe report.");
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ status: "duplicate", item_id: first.json.item_id });
    const other = await save("Mixed language test 混合语言测试. Please review the other report.");
    expect(other.status).toBe(201);
    const list = await call(env, "GET", "/v1/items?state=today", { token: ann.token });
    expect(list.json.items).toHaveLength(2);
    // Deleting the first lets the same text be saved again as a new item.
    await call(env, "DELETE", `/v1/items/${first.json.item_id}`, { token: ann.token });
    expect((await save("Mixed language test 混合语言测试. Please review the report.")).status).toBe(201);
  });
});
