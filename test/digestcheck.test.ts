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

describe("internal-qa #27 (QA's reproduction on c9b9fea): a quantity that is not the whole set's is not a claim", () => {
  it("the three summaries QA found refused although they agree with the digest's 16: a duration, a subset, a weight", () => {
    const cases: [string, number[]][] = [
      ["You saved 16 items today. Steep the tea for a total of 5 minutes.", [16]],
      ["今天存入了16条。其中共3条讲茶。", [16]],
      ["今天存入了16条。茶叶合计50克。", [16]],
      ["You saved 16 items today.", [16]], // QA's control
    ];
    for (const [text, want] of cases) {
      expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => ${want}`);
      expect(`${text} => ${wrongTotal(text, 16)}`).toBe(`${text} => null`);
    }
  });

  it("other quantities of the same kind: time, weight, money, steps, a price, a number of cups", () => {
    for (const text of [
      "You saved 16 items today. The reading adds up to a total of 3 hours.",
      "You saved 16 items today. Brew with a total of 4 grams of leaves and a total of 200 ml of water.",
      "You saved 16 items today. The three tea shops charge a total of 30 dollars.",
      "You saved 16 items today. The recipe has a total of 6 steps.",
      "今天存入了16条。阅读时间共3个小时。",
      "今天存入了16条。泡茶要两个步骤，一共花了10分钟。",
      "今天存入了16条。三种茶共5斤，合计120元。",
      "今天存入了16条。这个月共4次存入过茶的文章。",
    ]) {
      expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => 16`);
    }
  });

  it("subsets and topics are not claims about the whole: said as such, or a topic or a source right after the number", () => {
    for (const text of [
      "You saved 16 items today. Of these, 3 items were saved from videos.",
      "You saved 16 items, including 3 items saved from videos.",
      "You saved 16 items, and 3 items were saved from videos.",
      "You saved 16 items, among them 4 analysed items about tea.",
      "You saved 16 items. Out of 16 items, 3 items were analysed twice.",
      "今天存入了16条，其中存入了3条视频。",
      "今天存入了16条，当中共3条讲茶，其余讲咖啡。",
      "今天存入了16条。茶叶共3条。", // a count of one topic, in a later sentence
    ]) {
      expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => 16`);
    }
    // A part said alone (no whole stated) is no claim either.
    for (const text of ["You saved 3 items about tea and 13 about coffee.", "今天存入了3条讲茶的，13条讲咖啡的。"]) expect(`${text} => ${statedTotals(text)}`).toBe(`${text} => `);
  });

  it("the whole set's total is still a claim, whatever else the summary says about quantities", () => {
    expect(wrongTotal("You saved 15 items today. Steep the tea for a total of 5 minutes.", 16)).toBe(15);
    expect(wrongTotal("今天存入了十五条。茶叶合计50克。", 16)).toBe(15);
    expect(wrongTotal("今天共15条，其中3条讲茶。", 16)).toBe(15);
    expect(wrongTotal("共计十五份。其中共3条讲茶。", 16)).toBe(15);
    expect(wrongTotal("A total of 15 items, mostly about tea.", 16)).toBe(15);
    expect(wrongTotal("A total of 15 across the day, and 5 minutes of reading in total.", 16)).toBe(15);
    expect(wrongTotal("You saved 16 items. Altogether 15 items were analysed.", 16)).toBe(15);
    expect(wrongTotal("这份每日摘要汇总了 15 条解读，阅读共需 3 个小时。", 16)).toBe(15);
    // The same sentences with the right number are fine.
    expect(wrongTotal("You saved 16 items today. Steep the tea for a total of 5 minutes.", 16)).toBeNull();
    expect(wrongTotal("今天共16条，其中3条讲茶。", 16)).toBeNull();
  });
});

describe("internal-qa #27 (QA's review of a3c855e): the digest as the subject of a verb of scope counts the whole set, whatever is said of it after the number", () => {
  it("QA's two examples: a wrong 15 for 16 items is refused; the same sentences with 16 are accepted", () => {
    const wrong = ["This digest covers 15 items, which span tea and coffee.", "这份每日摘要汇总了15条关于茶的解读。"];
    const right = ["This digest covers 16 items, which span tea and coffee.", "这份每日摘要汇总了16条关于茶的解读。"];
    for (const text of wrong) {
      expect(`${text} ${JSON.stringify(statedTotals(text))} ${wrongTotal(text, 16)}`).toBe(`${text} [15] 15`);
    }
    for (const text of right) {
      expect(`${text} ${JSON.stringify(statedTotals(text))} ${wrongTotal(text, 16)}`).toBe(`${text} [16] null`);
    }
  });

  it("other ways to say the digest covers a number, with a topic or a clause after it", () => {
    const wrong: [string, number][] = [
      ["Today's digest covers fifteen items about tea.", 15],
      ["The summary covers 15 items, mostly about tea.", 15],
      ["This daily digest has covered 15 links that are mostly about tea.", 15],
      ["本份摘要涵盖了十五条讲茶的内容。", 15],
      ["这份摘要包含了15条与茶有关的解读。", 15],
      ["这一份每日摘要汇总了15篇和茶相关的文章。", 15],
    ];
    for (const [text, n] of wrong) expect(`${text} ${wrongTotal(text, 16)}`).toBe(`${text} ${n}`);
  });

  it("the controls QA asked to keep: quantities, subsets and topics that are not about the whole set are still not claims", () => {
    const fine = [
      "You saved 16 items today. Steep the tea for a total of 5 minutes.",
      "今天存入了16条。其中共3条讲茶。",
      "今天存入了16条。茶叶合计50克。",
      // A topic after a count that is not the digest's own scope: still a part.
      "You saved 3 items about tea.",
      "这份摘要里共3条讲茶。",
      "The digest has 3 items saved from videos.",
      // The digest as the subject, but not a verb of scope, and not a count of the items.
      "This digest took 5 minutes to write.",
      "这份摘要大约要读5分钟。",
      // A subset marker still wins over the frame.
      "This digest covers 16 items, of these 3 items about tea.",
      "这份摘要汇总了16条，其中共3条讲茶。",
    ];
    for (const text of fine) expect(`${text} ${wrongTotal(text, 16)}`).toBe(`${text} null`);
  });

  it("a genuine miscount is still refused, with or without the frame", () => {
    for (const [text, n] of [
      ["You saved 15 items today. Steep the tea for a total of 5 minutes.", 15],
      ["今天共15条，其中3条讲茶。", 15],
      ["This digest covers 15 items.", 15],
      ["这份每日摘要汇总了15条解读。", 15],
    ] as const) {
      expect(`${text} ${wrongTotal(text, 16)}`).toBe(`${text} ${n}`);
    }
  });
});
