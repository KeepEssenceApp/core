from __future__ import annotations

import unittest

from ke_transcriber import quality as q

from .helpers import seg


class DropReasonTests(unittest.TestCase):
    def test_silence_needs_both_a_high_no_speech_probability_and_a_low_logprob(self) -> None:
        self.assertEqual(q.drop_reason(seg("你好世界朋友", no_speech_prob=0.7, avg_logprob=-1.2)), "silence")
        # Whisper's own test is both at once: a segment it is unsure about but is not sure was silence stays.
        self.assertIsNone(q.drop_reason(seg("你好世界朋友", no_speech_prob=0.7, avg_logprob=-0.5)))
        self.assertIsNone(q.drop_reason(seg("你好世界朋友", no_speech_prob=0.5, avg_logprob=-1.5)))

    def test_the_thresholds_are_strict(self) -> None:
        self.assertIsNone(q.drop_reason(seg("你好世界朋友", no_speech_prob=0.6, avg_logprob=-1.2)))
        self.assertIsNone(q.drop_reason(seg("你好世界朋友", no_speech_prob=0.7, avg_logprob=-1.0)))
        self.assertIsNone(q.drop_reason(seg("你好世界朋友", compression_ratio=2.4)))

    def test_a_high_compression_ratio_is_a_loop_or_gibberish(self) -> None:
        self.assertEqual(q.drop_reason(seg("好好好好好好好好好好", compression_ratio=2.5)), "gibberish")

    def test_blank(self) -> None:
        for text in ("", "   ", "。。。", "...", "♪ ♪", "- -", "？！", "\n"):
            with self.subTest(text=text):
                self.assertEqual(q.drop_reason(seg(text)), "blank")

    def test_sound_tags(self) -> None:
        for text in ("[Music]", " (音乐) ", "【掌声】", "[BLANK_AUDIO]", "（笑）"):
            with self.subTest(text=text):
                self.assertEqual(q.drop_reason(seg(text)), "tag")

    def test_a_sentence_with_a_bracket_in_it_is_not_a_tag(self) -> None:
        self.assertIsNone(q.drop_reason(seg("他说（开玩笑的）然后走了")))
        self.assertIsNone(q.drop_reason(seg("[Music] and then he spoke")))

    def test_ordinary_speech_passes_even_when_unsure(self) -> None:
        self.assertIsNone(q.drop_reason(seg("今天天气很好。")))
        self.assertIsNone(q.drop_reason(seg("Hello there.", avg_logprob=-1.4, no_speech_prob=0.2)))


class CollapseRepeatsTests(unittest.TestCase):
    def texts(self, segments):
        return [s.text for s in segments]

    def test_three_in_a_row_keep_one(self) -> None:
        self.assertEqual(self.texts(q.collapse_repeats([seg("好的。")] * 3)), ["好的。"])
        self.assertEqual(self.texts(q.collapse_repeats([seg("好的。")] * 9)), ["好的。"])

    def test_two_in_a_row_are_someone_repeating_themselves(self) -> None:
        self.assertEqual(self.texts(q.collapse_repeats([seg("好的。")] * 2)), ["好的。", "好的。"])

    def test_spelling_differences_do_not_hide_a_loop(self) -> None:
        loop = [seg("好的。"), seg("好的"), seg("好的！"), seg(" 好的 ")]
        self.assertEqual(len(q.collapse_repeats(loop)), 1)
        loop = [seg("Thank you."), seg("thank you"), seg("Thank you!")]
        self.assertEqual(len(q.collapse_repeats(loop)), 1)

    def test_separated_repeats_stay(self) -> None:
        a, b = seg("甲说话了"), seg("乙说话了")
        self.assertEqual(self.texts(q.collapse_repeats([a, a, b, a, a])), ["甲说话了", "甲说话了", "乙说话了", "甲说话了", "甲说话了"])

    def test_each_run_is_judged_alone_and_order_is_kept(self) -> None:
        a, b, c = seg("第一句话"), seg("第二句话"), seg("第三句话")
        self.assertEqual(self.texts(q.collapse_repeats([c, a, a, a, b, b, b, b, c])), ["第三句话", "第一句话", "第二句话", "第三句话"])

    def test_nothing_to_do(self) -> None:
        self.assertEqual(q.collapse_repeats([]), [])


class StockPhraseTests(unittest.TestCase):
    STOCK = [
        "字幕由Amara.org社区提供", "字幕由 某某某 制作", "字幕志愿者 杨茜茜", "中文字幕提供", "谢谢观看。", "谢谢大家观看", "感谢您的观看！",
        "感谢收看本期节目", "请不要忘记订阅", "请不要忘记订阅我的频道", "点赞订阅转发打赏支持明镜与点点栏目", "请订阅", "下期再见", "我们下期再见。",
        "Thanks for watching!", "Thank you for watching.", "Thank you for watching this video", "Thank you.", "Thanks", "Thank you very much.",
        "Please subscribe.", "Don't forget to subscribe!", "Like and subscribe", "Please subscribe to my channel",
        "Subtitles by the Amara.org community", "Transcribed by someone", "See you next time.", "See you in the next video!", "Bye.",
        "ご視聴ありがとうございました", "チャンネル登録お願いします",
    ]
    REAL = [
        "今天我们讲谢谢观看这个词是怎么来的", "Thank you for the gift, it was very kind of you", "I will subscribe to this magazine because it is cheap",
        "字幕由" + "很长的一段话" * 20, "谢谢你昨天帮我搬家", "Bye the way, did you see it", "We will see you at the airport tomorrow morning",
        "今天天气很好。", "",
        "。",
    ]

    def test_stock_lines(self) -> None:
        for text in self.STOCK:
            with self.subTest(text=text):
                self.assertTrue(q.is_stock_phrase(text))

    def test_real_speech_that_mentions_them_is_not(self) -> None:
        for text in self.REAL:
            with self.subTest(text=text[:30]):
                self.assertFalse(q.is_stock_phrase(text))

    def test_dropped_when_last(self) -> None:
        a = seg("今天我们来聊聊茶。")
        self.assertEqual(q.drop_trailing_stock([a, seg("谢谢观看")]), [a])
        self.assertEqual(q.drop_trailing_stock([a, seg("请不要忘记订阅"), seg("谢谢观看")]), [a])

    def test_dropped_when_only(self) -> None:
        self.assertEqual(q.drop_trailing_stock([seg("字幕由Amara.org社区提供")]), [])

    def test_kept_when_not_last_or_not_alone(self) -> None:
        a, b, stock = seg("今天我们来聊聊茶。"), seg("明天再说别的话题。"), seg("谢谢观看")
        self.assertEqual(q.drop_trailing_stock([a, stock, b]), [a, stock, b])
        self.assertEqual(q.drop_trailing_stock([stock, a]), [stock, a])


class HasSpeechTests(unittest.TestCase):
    def test_chinese_needs_five_characters(self) -> None:
        self.assertFalse(q.has_speech("你好吗", "zh"))
        self.assertFalse(q.has_speech("你好，吗？", "zh"))  # punctuation is not a character
        self.assertFalse(q.has_speech("你好你好", "zh"))
        self.assertTrue(q.has_speech("你好你好吗", "zh"))
        self.assertTrue(q.has_speech("今天天气很好。", "zh"))

    def test_other_languages_need_three_words(self) -> None:
        self.assertFalse(q.has_speech("Hello there.", "en"))
        self.assertFalse(q.has_speech("... --- !!! Hello", "en"))
        self.assertTrue(q.has_speech("Hello there friend", "en"))

    def test_japanese_counts_characters(self) -> None:
        self.assertTrue(q.has_speech("ありがとう", "ja"))
        self.assertFalse(q.has_speech("ありが", "ja"))

    def test_the_text_decides_when_the_label_is_wrong(self) -> None:
        self.assertTrue(q.has_speech("今天天气很好", "en"))  # no spaces, but it is Chinese
        self.assertFalse(q.has_speech("你好", ""))


class JoinTests(unittest.TestCase):
    def test_chinese_is_joined_without_spaces(self) -> None:
        self.assertEqual(q.join_texts(["大家好，", "今天聊茶。"]), "大家好，今天聊茶。")

    def test_english_is_joined_with_a_space(self) -> None:
        self.assertEqual(q.join_texts([" Hello.", " World"]), "Hello. World")

    def test_mixed_boundaries(self) -> None:
        self.assertEqual(q.join_texts(["我很喜欢", "iPhone", "这个手机"]), "我很喜欢iPhone这个手机")
        self.assertEqual(q.join_texts(["I love", "iPhone"]), "I love iPhone")

    def test_whitespace_is_tidied(self) -> None:
        self.assertEqual(q.join_texts(["  a\n b  ", "", "   ", "c"]), "a b c")


class CleanTests(unittest.TestCase):
    def test_pipeline_keeps_speech_and_drops_the_outro(self) -> None:
        out = q.clean([seg("大家好，"), seg("今天我们来聊聊茶。"), seg("谢谢观看")], "zh", 30000)
        self.assertEqual((out.text, out.speech), ("大家好，今天我们来聊聊茶。", True))

    def test_a_loop_is_one_line(self) -> None:
        loop = [seg("我们一起来看看这个。")] * 6
        out = q.clean([seg("开头的一句话。")] + loop + [seg("结尾的一句话。")], "zh", 30000)
        self.assertEqual(out.text, "开头的一句话。我们一起来看看这个。结尾的一句话。")

    def test_a_loop_of_an_outro_is_dropped_too(self) -> None:
        out = q.clean([seg("今天我们来聊聊茶。")] + [seg("谢谢观看")] * 5, "zh", 30000)
        self.assertEqual(out.text, "今天我们来聊聊茶。")

    def test_only_stock_lines_is_no_speech(self) -> None:
        self.assertEqual(q.clean([seg("字幕由Amara.org社区提供")], "zh", 30000), q.Cleaned("", False))

    def test_only_silence_and_noise_is_no_speech(self) -> None:
        bad = [seg("你好你好你好", no_speech_prob=0.9, avg_logprob=-2.0), seg("[Music]"), seg("♪"), seg("好好好好好好", compression_ratio=4.0)]
        self.assertEqual(q.clean(bad, "zh", 30000), q.Cleaned("", False))

    def test_a_few_characters_are_not_speech(self) -> None:
        self.assertEqual(q.clean([seg("嗯，好的。")], "zh", 30000), q.Cleaned("", False))  # 3 characters
        self.assertEqual(q.clean([seg(" Yes, okay.")], "en", 30000), q.Cleaned("", False))  # 2 words
        self.assertTrue(q.clean([seg(" Yes, that is okay.")], "en", 30000).speech)

    def test_a_segment_the_model_is_unsure_of_but_not_silent_about_is_kept(self) -> None:
        out = q.clean([seg("这一句话说得不太清楚。", avg_logprob=-1.6, no_speech_prob=0.1)], "zh", 30000)
        self.assertTrue(out.speech)

    def test_cap(self) -> None:
        out = q.clean([seg("字" * 20000), seg("字" * 20000)], "zh", 30000)
        self.assertEqual(len(out.text), 30000)

    def test_music_notes_are_not_text(self) -> None:
        out = q.clean([seg("♪ 我们都是好孩子呀 ♪")], "zh", 30000)
        self.assertEqual(out.text, "我们都是好孩子呀")

    def test_no_segments(self) -> None:
        self.assertEqual(q.clean([], "zh", 30000), q.Cleaned("", False))
