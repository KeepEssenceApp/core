import { describe, expect, it } from "vitest";
import { shorten } from "../src/util";

describe("K10 analysis fields: over-long text from the built-in assistant is shortened cleanly", () => {
  it("leaves short text alone", () => {
    expect(shorten("Short enough.", 60)).toBe("Short enough.");
  });
  it("cuts at a word boundary and marks the cut", () => {
    const long = "Commonplace books are personal notebooks for collecting quotes, proverbs, recipes and notes, usually organized under subject headings";
    const out = shorten(long, 120);
    expect([...out].length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(/\s$/.test(out.slice(0, -1))).toBe(false);
    expect(long[out.length - 1] === " " || /[,;:.]/.test(long[out.length - 1])).toBe(true);
  });
  it("counts characters, not bytes, for Chinese", () => {
    const long = "卡片盒是用编号、标签和交叉引用连接小卡片的个人知识管理与写作方法，历史可追溯到十六至十七世纪的学者，后来影响了超文本软件。".repeat(3);
    const out = shorten(long, 60);
    expect([...out].length).toBeLessThanOrEqual(60);
    expect(out.endsWith("…")).toBe(true);
  });
});
