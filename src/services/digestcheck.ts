// A daily digest's summary is prose written by a model (or another assistant); its header count and
// its lists are the snapshot's. This is the one place that says whether the prose contradicts the
// snapshot on the one fact that can be checked without understanding it: how many items it covers
// (core#3, internal-qa #27: a digest of 16 items whose summary said 15).
//
// Pure functions. It is a guard, not a proof: it finds a number stated as the total of items saved or
// covered, in digits, in English number words and in Chinese numerals up to 99. A number that is not
// stated as the total of the whole set is not a claim, and prose that states no number is always fine:
//   - a quantity of something else ("a total of 5 minutes", "茶叶合计50克", "共3个小时"): the thing counted
//     has to be the items (an item word or an item classifier), never a time, a weight or a price;
//   - a subset ("其中共3条", "of these, 3 items were saved from videos", "3 items about tea"): a subset
//     marker earlier in the sentence, or a topic or a source right after the number, makes it not a total;
//   - a bare total word ("共 3 条", "a total of 15") counts only where it is about the whole day: in the
//     summary's first sentence, or with a whole-day word beside it ("今天", "这份摘要", "across the day"). A summary that does not agree is never stored: the built-in assistant asks once more,
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

/**
 * How sure a pattern is that the number is the whole set's: "whole" says what it counted (it names a saving or covering
 * verb, or says "in total" after the item word); "bare" is a total word that could as well head a count of something
 * else or of a part of the day (see wholeDay).
 */
type Tier = "whole" | "bare";
/** What follows a number that is a part and not the whole: a topic ("3 items about tea", "共 3 条讲茶"). */
const TOPIC_AFTER_EN = /^\s*(?:,\s*)?(?:about|regarding|concerning|related\s+to|tagged|that|which|with)\b/i;
const TOPIC_AFTER_ZH = /^\s*(?:内容|条目|解读|链接|文章)?\s*(?:讲|谈|说|写|关于|有关|来自|涉及|提到|属于|出自|与|和|跟)/;
/** What follows "3 items were saved" that makes it a part: where they came from. */
const SOURCE_AFTER_EN = /^\s*(?:from|via|through|by|about)\b/i;
/** Said earlier in the same sentence: what comes next is a part of what was just counted. */
const SUBSET_BEFORE = /\b(?:of\s+(?:these|them|those|which)|among\s+(?:them|these|those|which|the)|including|such\s+as|out\s+of)\b|其中|当中|其余|另外|有的|有些|剩下/i;
/** The words that say a bare total is about the whole day, not about a topic. */
const WHOLE_DAY_ZH = /今天|今日|当天|本日|这份|摘要|每日|全部|所有|整天|一天|总体|汇总/;

const NOT_A_COUNT_ZH = "(?!小时|钟头|月|星期|礼拜|分钟|秒|人|步|克|斤|公斤|毫升|升|元|块|度|岁|次|遍)";

/** Each pattern has the number in its first capture group. They find a number stated as the total, never one that is only near an item word. */
const PATTERNS: { re: RegExp; tier: Tier; after: RegExp }[] = [
  // saved 15 items / saved a total of fifteen things / covers about 16 links
  { re: new RegExp(`\\b${EN_SAVE_VERB}\\s+(?:(?:a\\s+)?total\\s+of\\s+|about\\s+|around\\s+|roughly\\s+|only\\s+|just\\s+|exactly\\s+)?(${EN_NUM})\\s+(?:new\\s+|different\\s+|separate\\s+)?${EN_THING}\\b`, "dgi"), tier: "whole", after: TOPIC_AFTER_EN },
  // 15 items were saved / 15 things have been collected
  { re: new RegExp(`\\b(${EN_NUM})\\s+(?:new\\s+)?${EN_THING}\\s+(?:were\\s+|was\\s+|have\\s+been\\s+|got\\s+)?(?:saved|collected|captured|added|analy[sz]ed|summari[sz]ed|came\\s+in)\\b`, "dgi"), tier: "whole", after: SOURCE_AFTER_EN },
  // a total of 15 items / a total of 15 across the day: the thing counted is the items, or the whole day is said
  { re: new RegExp(`\\btotal\\s+of\\s+(${EN_NUM})(?=\\s+(?:new\\s+)?${EN_THING}\\b|\\s+(?:across|over|during|within|for)\\s+(?:the|this|that|all)\\s+(?:day|digest|summary)\\b|\\s+(?:today|altogether|overall|in\\s+all|in\\s+total)\\b)`, "dgi"), tier: "whole", after: TOPIC_AFTER_EN },
  // 16 items in total / 15 things altogether
  { re: new RegExp(`\\b(${EN_NUM})\\s+${EN_THING}\\s+(?:in\\s+total|in\\s+all|altogether|overall)\\b`, "dgi"), tier: "whole", after: TOPIC_AFTER_EN },
  // 共 15 条 / 一共有十五条 / 总共存入了 15 条 : the unit is the items' (not 小时, 克 ...), and the word is a bare one
  { re: new RegExp(`(?:共计|合计|总计|一共|总共|共)\\s*(?:有|是|为|存入了?|收集了?|保存了?|解读了?)?\\s*(${ZH_NUM})\\s*${ZH_UNIT}${NOT_A_COUNT_ZH}`, "dg"), tier: "bare", after: TOPIC_AFTER_ZH },
  // 存入了 15 条 / 解读了约十五篇
  { re: new RegExp(`${ZH_SAVE_VERB}\\s*(?:共|总共|一共|大约|约|差不多)?\\s*(${ZH_NUM})\\s*${ZH_UNIT}${NOT_A_COUNT_ZH}`, "dg"), tier: "whole", after: TOPIC_AFTER_ZH },
  // 15 条已存入 / 15 条内容被收集
  { re: new RegExp(`(${ZH_NUM})\\s*${ZH_UNIT}\\s*(?:内容|条目|解读|链接|文章)?\\s*(?:已经|已|都)?\\s*(?:被)?(?:存入|收集|保存|解读|汇总)`, "dg"), tier: "whole", after: TOPIC_AFTER_ZH },
];

/** The sentences of a summary, with where each stands. */
function sentences(text: string): { start: number; end: number }[] {
  return [...text.matchAll(/[^.!?;。！？；\n]+/g)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
}

/** The numbers the summary states as how many items were saved or covered, in the order they appear. */
export function statedTotals(summary: string): number[] {
  const all = sentences(summary);
  // Keyed by where the number itself stands: two patterns that find the same number found one claim.
  const found = new Map<number, number>();
  for (const { re, tier, after } of PATTERNS) {
    for (const m of summary.matchAll(re)) {
      const n = toNumber(m[1]);
      const at = m.indices?.[1]?.[0];
      if (n === null || at === undefined) continue;
      const from = m.index!;
      const sentenceIndex = all.findIndex((x) => from >= x.start && from < x.end);
      const sentence = all[sentenceIndex] ?? { start: 0, end: summary.length };
      const before = summary.slice(sentence.start, from);
      // A part, not the whole: something said earlier makes what follows a subset, or a topic or a source follows.
      if (SUBSET_BEFORE.test(before) || after.test(summary.slice(from + m[0].length, sentence.end))) continue;
      // A bare total word is about the whole day only in the first sentence or beside a whole-day word.
      if (tier === "bare" && sentenceIndex > 0 && !WHOLE_DAY_ZH.test(before)) continue;
      found.set(at, n);
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
