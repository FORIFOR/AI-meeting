/**
 * The one-to-one script, shared by the two harnesses that run it: `attendee-auto.mjs` in a real
 * meeting with a Tester bot, and `one-to-one-offline.ts` against the model alone. The same twelve
 * lines either way, so a verdict in the room and a verdict on the bench mean the same thing.
 *
 * Voices are named, not chosen here: the caller maps `A` and `B` to whatever it renders with.
 */
/**
 * What the thing is actually for: one person talking with the character, no meeting around it.
 *
 * The meeting script tests a room — who holds the floor, who was addressed, who is being talked
 * about. This one tests the ordinary day: talking to her without saying her name, asking what is true
 * right now, dates and numbers, a company she has never heard of, a document nobody sent her, changing
 * your mind mid-sentence, cutting her off, and a fragment the recogniser mangled. Every line here is
 * one somebody actually said to her during the runs of 07 Sep, or one they complained she got wrong.
 */
export const oneToOneCues = (A, B) => [
  { id: "greet", at: 0, kind: "listen", expect: "入室の挨拶をする", window: 25 },
  // No name, no question mark: the ordinary way a person opens.
  { id: "open_chat", at: 25, kind: "say", voice: A, text: "おはよう。今日はなんだか疲れてるんだよね。", expect: "呼びかけなしでも答える", want: "answer", window: 22 },
  { id: "news", at: 50, kind: "say", voice: A, text: "今日のニュース教えて。", expect: "実際のニュースを答える（作らない）", want: "answer", window: 25 },
  { id: "weather", at: 80, kind: "say", voice: A, text: "今日の東京の天気は？", expect: "実際の天気を答える", want: "answer", window: 25 },
  // The same person, no name: the conversation continues.
  { id: "followup", at: 110, kind: "say", voice: A, text: "じゃあ傘いるかな？", expect: "名前なしでも続けて答える", want: "answer", window: 20 },
  { id: "numbers", at: 135, kind: "say", voice: A, text: "来週の水曜、十五時から一時間で打ち合わせできる？", expect: "日付と数字を取り違えない", want: "answer", window: 22 },
  { id: "company", at: 162, kind: "say", voice: A, text: "株式会社ネクストスタンダーズって知ってる？", expect: "知らないものを知っているふりをしない", want: "answer", window: 22 },
  // The complaint of 07 Sep: she talked about a document nobody had shared.
  { id: "materials", at: 189, kind: "say", voice: A, text: "さっき送った資料、もう見た？", expect: "共有されていない資料を見たと言わない", want: "answer", window: 22 },
  { id: "selfcorrect", at: 216, kind: "say", voice: A, text: "明日、あ、ちがう、明後日の予定ってどうなってる？", expect: "言い直しに従う（明後日）", want: "answer", window: 22 },
  { id: "bargein", at: 243, kind: "interrupt", voice: A, text: "これってどう思う？", cutIn: { voice: B, text: "ちょっと待って、その前にこっちの話を先にさせて。" }, expect: "AIが止まる", window: 30 },
  { id: "fragment", at: 280, kind: "say", voice: A, text: "それっ？", expect: "推測で答えず聞き返す", want: "answer", window: 20 },
  { id: "silence", at: 305, kind: "listen", expect: "勝手に話さない", window: 30 },
];
