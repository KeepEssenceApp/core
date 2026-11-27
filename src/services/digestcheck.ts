// A daily digest's summary is prose written by a model (or another assistant); its header count and
// its lists are the snapshot's. This is the one place that says whether the prose contradicts the
// snapshot on the one fact that can be checked without understanding it: how many items it covers
// (core#3, internal-qa #27: a digest of 16 items whose summary said 15).
//
// Pure functions. It is a guard, not a proof: it finds a number stated as the total of items saved or
// covered, in digits, in English number words and in Chinese numerals up to 99. A number that is not
// stated as a total ("3 of them are about tea") is not a claim, and prose that states no number is
// always fine. A summary that does not agree is never stored: the built-in assistant asks once more,
// then writes the sentence itself from the snapshot (see fallbackSummary); another assistant is
// refused with the reason, as the contract says for a result that breaks a field rule.

const EN_ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const ZH_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** "fifteen", "twenty-three" or "twenty three" as a number up to 99; null when it is not one. */
function englishNumber(word: string): number | null {
  const w = word.toLowerCase().replace(/-/g, " ").trim();
  if (w in EN_ONES) return EN_ONES[w];
  const [tens, ones, ...rest] = w.split(/\s+/);
  if (rest.length === 0 && tens in EN_TENS) {
    if (ones === undefined) return EN_TENS[tens];
    if (ones in EN_ONES && EN_ONES[ones] >= 1 && EN_ONES[ones] <= 9) return EN_TENS[tens] + EN_ONES[ones];
  }
  return null;
}

/** "十五", "二十", "二十三", "三", "两" as a number up to 99; null when it is not one. */
function chineseNumber(s: string): number | null {
  if (s === "十") return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? ZH_DIGITS[m[1]] : 1) * 10 + (m[2] ? ZH_DIGITS[m[2]] : 0);
  return s.length === 1 && s in ZH_DIGITS ? ZH_DIGITS[s] : null;
}

function toNumber(token: string): number | null {
  if (/^\d{1,4}$/.test(token)) return Number(token);
  return englishNumber(token) ?? chineseNumber(token);
}

const EN_WORDS = [...Object.keys(EN_ONES), ...Object.keys(EN_TENS)].sort((a, b) => b.length - a.length).join("|");
const EN_TENS_ALT = Object.keys(EN_TENS).join("|");
const EN_NUM = `\\d{1,4}|(?:${EN_TENS_ALT})(?:[ -](?:one|two|three|four|five|six|seven|eight|nine))?|${EN_WORDS}`;
const ZH_NUM = "\\d{1,4}|[零〇一二两三四五六七八九十]{1,3}";

const EN_THING = "(?:items?|things?|links?|pieces?|articles?|posts?|pages?|analys[ie]s|entries)";
const ZH_UNIT = "(?:条|个|篇|份|项|则|件)";
const EN_SAVE_VERB = "(?:saved|collected|captured|added|covers?|covered|covering|analy[sz]ed|summari[sz]ed)";
const ZH_SAVE_VERB = "(?:存入了?|存了|收藏了?|收集了?|保存了?|记录了?|解读了?|分析了?|汇总了?|涵盖了?|包含了?)";

/** Each pattern has the number in its first capture group. They find a number stated as the total, never one that is only near an item word. */
const PATTERNS: RegExp[] = [
  // saved 15 items / saved a total of fifteen things / covers about 16 links
  new RegExp(`\\b${EN_SAVE_VERB}\\s+(?:(?:a\\s+)?total\\s+of\\s+|about\\s+|around\\s+|roughly\\s+|only\\s+|just\\s+|exactly\\s+)?(${EN_NUM})\\s+(?:new\\s+|different\\s+|separate\\s+)?${EN_THING}\\b`, "dgi"),
  // 15 items were saved / 15 things have been collected
  new RegExp(`\\b(${EN_NUM})\\s+(?:new\\s+)?${EN_THING}\\s+(?:were\\s+|was\\s+|have\\s+been\\s+|got\\s+)?(?:saved|collected|captured|added|analy[sz]ed|summari[sz]ed|came\\s+in)\\b`, "dgi"),
  // a total of 15 / 15 items in total / 15 things altogether
  new RegExp(`\\btotal\\s+of\\s+(${EN_NUM})\\b`, "dgi"),
  new RegExp(`\\b(${EN_NUM})\\s+${EN_THING}\\s+(?:in\\s+total|in\\s+all|altogether|overall)\\b`, "dgi"),
  // 共 15 条 / 一共有十五条 / 总共存入了 15 条
  new RegExp(`(?:共计|合计|总计|一共|总共|共)\\s*(?:有|是|为|存入了?|收集了?|保存了?|解读了?)?\\s*(${ZH_NUM})\\s*${ZH_UNIT}?`, "dg"),
  // 存入了 15 条 / 解读了约十五篇
  new RegExp(`${ZH_SAVE_VERB}\\s*(?:共|总共|一共|大约|约|差不多)?\\s*(${ZH_NUM})\\s*${ZH_UNIT}`, "dg"),
  // 15 条已存入 / 15 条内容被收集
  new RegExp(`(${ZH_NUM})\\s*${ZH_UNIT}\\s*(?:内容|条目|解读|链接|文章)?\\s*(?:已经|已|都)?\\s*(?:被)?(?:存入|收集|保存|解读|汇总)`, "dg"),
];

/** The numbers the summary states as how many items were saved or covered, in the order they appear. */
export function statedTotals(summary: string): number[] {
  // Keyed by where the number itself stands: two patterns that find the same number found one claim.
  const found = new Map<number, number>();
  for (const re of PATTERNS) {
    for (const m of summary.matchAll(re)) {
      const n = toNumber(m[1]);
      const at = m.indices?.[1]?.[0];
      if (n !== null && at !== undefined) found.set(at, n);
    }
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}

/** The first number the summary states as the total that is not `total`; null when it states none, or only the right one. */
export function wrongTotal(summary: string, total: number): number | null {
  return statedTotals(summary).find((n) => n !== total) ?? null;
}

/**
 * What the built-in assistant writes itself when the model's summary will not agree with the snapshot: a
 * plain sentence from the snapshot's own number, in the account's language. Nothing is invented.
 */
export function fallbackSummary(total: number, lang: "zh" | "en"): string {
  return lang === "zh" ? `这份每日摘要汇总了 ${total} 条解读。` : `This daily digest covers ${total} ${total === 1 ? "analysis" : "analyses"}.`;
}

/** The refusal reason, in both languages: names the number the digest does cover. */
export function mismatchReason(stated: number, total: number): { zh: string; en: string } {
  return {
    zh: `总结里说的是 ${stated} 条，这份每日摘要实际汇总的是 ${total} 条。请改成 ${total} 条，或者不写数目`,
    en: `the summary says ${stated} items, but this digest covers ${total}. State ${total}, or no number`,
  };
}
