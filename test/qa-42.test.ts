import { describe, expect, it } from "vitest";
import { textLength } from "../src/builtin";

describe("QA #42: the length of a text is counted by the core, the same every time", () => {
  it("QA #42: words for text with spaces, characters for Chinese, and the same answer for the same text", () => {
    expect(textLength("random-click probe 18:00")).toEqual({ words: 3, cjk_characters: 0 });
    expect(textLength("random-click probe 18:04")).toEqual({ words: 3, cjk_characters: 0 });
    expect(textLength("明天上午十点开会")).toEqual({ words: 0, cjk_characters: 8 });
    expect(textLength("Mixed 混合 test, twice — yes.")).toEqual({ words: 4, cjk_characters: 2 });
    expect(textLength("  ")).toEqual({ words: 0, cjk_characters: 0 });
  });
});
