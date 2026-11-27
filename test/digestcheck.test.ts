// core#3 / internal-qa #27: a daily digest's summary does not state a count that is not the digest's.
// The pure rule; the digest flow is in digest-count.test.ts. Every sentence here is made up.
import { describe, expect, it } from "vitest";
import { fallbackSummary, mismatchReason, statedTotals, wrongTotal } from "../src/services/digestcheck";

describe("the numbers a summary states as how many items it covers", () => {
  it("English: digits and number words, before or after the item word", () => {
    const cases: [string, number[]][] = [
      ["You saved 15 items today.", [15]],
      ["You saved fifteen items today, mostly about tea.", [15]],
      ["You saved twenty-three things.", [23]],
      ["You saved twenty three things.", [23]],
      ["Today's digest covers 16 analyses.", [16]],
      ["It covers a total of 16 links.", [16]],
      ["15 items were saved, and most were about tea.", [15]],
      ["Sixteen things have been collected so far.", [16]],
      ["A total of 15 across the day.", [15]],
      ["16 items in total, none urgent.", [16]],
      ["You collected about 15 articles.", [15]],
      ["You added just 1 item.", [1]],
    ];
    for (const [text, want] of cases) expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => ${want}`);
  });

  it("Chinese: digits and numerals up to 99", () => {
    const cases: [string, number[]][] = [
      ["今天存入了 15 条，大多和茶有关。", [15]],
      ["今天存入了十五条。", [15]],
      ["一共有二十三篇。", [23]],
      ["总共存入了 16 条内容。", [16]],
      ["共 16 条，其中有几条值得读。", [16]],
      ["共计十六份。", [16]],
      ["这份每日摘要汇总了 16 条解读。", [16]],
      ["15 条已存入。", [15]],
      ["解读了约两篇。", [2]],
    ];
    for (const [text, want] of cases) expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => ${want}`);
  });

  it("a number that is not stated as the total is not a claim, and prose without a number is fine", () => {
    for (const text of [
      "Mostly about tea, with a few notes on brewing.",
      "3 of them are about tea and 2 about coffee.",
      "Steep green tea for 2 minutes; the second cup needs 90 seconds.",
      "In the 21st century, 4 items stand out: the first two are about tea.",
      "You saved a lot today, mostly about tea.",
      "今天的内容大多和茶有关，其中 3 条值得细读。",
      "第二条讲了 5 个步骤。",
      "",
    ]) {
      expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => `);
    }
  });
});

describe("the number that is not the digest's", () => {
  it("is the first stated total that differs; the right number, or none, is fine", () => {
    expect(wrongTotal("You saved 15 items today.", 16)).toBe(15);
    expect(wrongTotal("You saved 16 items today.", 16)).toBeNull();
    expect(wrongTotal("Mostly about tea.", 16)).toBeNull();
    expect(wrongTotal("今天存入了十五条。", 16)).toBe(15);
    expect(wrongTotal("共 16 条，其中 3 条值得读。", 16)).toBeNull();
    // Two totals that disagree with each other: the one that is wrong is named.
    expect(wrongTotal("You saved 16 items; 15 items were analysed.", 16)).toBe(15);
    expect(wrongTotal("You saved 1 item.", 1)).toBeNull();
  });

  it("the fallback sentence is the snapshot's own and always agrees; the reason names the number the digest has", () => {
    for (const total of [1, 2, 16, 200]) {
      for (const lang of ["en", "zh"] as const) {
        const s = fallbackSummary(total, lang);
        expect(`${lang} ${total} ${wrongTotal(s, total)}`).toBe(`${lang} ${total} null`);
        expect(statedTotals(s)).toEqual([total]);
      }
    }
    expect(fallbackSummary(1, "en")).toBe("This daily digest covers 1 analysis.");
    expect(fallbackSummary(16, "en")).toBe("This daily digest covers 16 analyses.");
    expect(fallbackSummary(16, "zh")).toBe("这份每日摘要汇总了 16 条解读。");
    const why = mismatchReason(15, 16);
    expect(why.en).toContain("15");
    expect(why.en).toContain("16");
    expect(why.zh).toContain("16");
  });
});
