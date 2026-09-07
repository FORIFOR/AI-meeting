/**
 * What the character is told about being in a meeting — the session instructions appended to the
 * persona, and the per-turn text handed to the model when the room addresses it. Pure text, shared by
 * the meeting session (apps/web) and the offline conversation gate (scripts/reality/conversation-eval),
 * so the wording that is measured is the wording that ships.
 */

/**
 * The persona a meeting uses when nobody chose one (`personas/meeting/colleague_ja.json`): a colleague
 * who answers what was asked, not the friend who draws the other person out — a question back on every
 * turn is a conversation starter, and a meeting already has one.
 */
import { SHORT_QUESTIONS } from "./participationPolicy.js";

export const MEETING_PERSONA_ID = "meeting_colleague_ja";

/**
 * Which setting a persona puts the character in. The same signal that decides whether it waits to be
 * called (`defaultProactivityFor`) decides whether it is told there is a meeting around it: a
 * character that answers unasked in a one-to-one must not also believe there are minutes and shared
 * documents in the room.
 */
export function settingFor(input: { personaId?: string | null; mode?: string | null }): "meeting" | "one_to_one" {
  return input.personaId === MEETING_PERSONA_ID || input.mode === "meeting" ? "meeting" : "one_to_one";
}

export interface MeetingInstructionsInput {
  /** The name the character joined under — what the room calls it. */
  displayName: string;
  /** True when the character may join in unasked (any proactivity other than `addressed_only`). */
  proactive: boolean;
  /** Other spellings of the name the recognisers produce (the character pack's aliases: 「ゆい」「ユイ」「結衣」). */
  aliases?: string[];
  /**
   * Where the conversation is happening. `meeting` is a room with other people, minutes and shared
   * material; `one_to_one` is the ordinary case — one person talking with the character, with none of
   * those things. Told it was in a meeting, the character talked about documents nobody had shared
   * (「共有していない資料の話をしてきます」, 2026-09-07) because every example it was given was a
   * meeting example. Default `meeting`, which is what a meeting still gets.
   */
  setting?: "meeting" | "one_to_one";
  /**
   * Whether the model can look things up (Gemini Live's own search grounding). Told it cannot, a
   * character that can grounds nothing and says 「今ここでは分からない」 to a person who asked for the
   * news — twice, on the same day, from the same person. Default false: the local engine cannot.
   */
  canSearch?: boolean;
  /**
   * The wall clock at the start of the session, as the page knows it ("2026-09-07 21:05" plus the
   * weekday). A provider that decides its own turns never sees the per-turn prompt, so this is the
   * only place it learns what day it is — and without it 「来週の水曜」 came back as a date three
   * weeks out, stated with confidence (one-to-one script, 07 Sep).
   */
  now?: string;
}

/**
 * The visual half of the instructions matters as much as the conversational half: a model handed
 * face measurements will otherwise narrate them back as psychology — 「不安そうですね」 — to a real
 * person in a real meeting. Cues are uncertain observations that may earn a reply, never a
 * diagnosis, and never something to say out loud.
 */
export function meetingInstructions({ displayName, proactive, aliases = [], setting = "meeting", canSearch = false, now }: MeetingInstructionsInput): string {
  // Whisper writes the name as a Japanese given name: 「結衣が昨日そう言ってたよね」. Told only that
  // 「ゆイ」「うい」 are mishearings, the model read 「結衣」 as a colleague and answered 「結衣さんが言って
  // いたのは…」 8 times out of 8 (echo probe, sim 41 context). Every spelling is the character itself.
  const spellings = [...new Set([...aliases, "ゆイ", "うい"].filter((a) => a && a !== displayName))].map((a) => `「${a}」`).join("");
  // One rule per line. As a single paragraph the later rules were the ones the model dropped: with
  // the demonstrative rule appended, the invented schedule the honesty rule had cured came back in
  // two runs out of three (conversation gate, meeting-gate scenario).
  const nameRules = [
    `・発言は音声認識の書き起こしなので、あなたの名前「${displayName}」が${spellings}のように別の表記になっていることがある。どの表記もあなた自身のこと（別の参加者ではない）。返答であなた自身の名前や、相手が使った表記を繰り返さない。`,
    "・相手の名前は、書き起こしにある表記のまま使う（訳したり言い換えたりしない。読みをカタカナにするのはよい）。分からなければ名前を使わずに話す。「〇〇さん」のような伏せ字は絶対に言わない。",
  ];
  const liveInfoRule = canSearch
    ? "・ニュース・天気・株価・交通情報などの今の情報は、検索して答えてよい。調べた内容はそのまま短く伝え、分からなかったときは分からないと言う。憶測で数字や日付を作らない。出典のURLは読み上げない。現在時刻は【現在時刻】が添えられているときだけ、それを使って答える。"
    : null;
  /**
   * The recogniser drops words, and a model handed half a sentence answers the half it got as though
   * it were the whole. 「田中さんが……までやります」 answered as a date the character invented is worse
   * than asking; the one thing a person cannot forgive is being confidently misheard.
   */
  const misheardRule = "・聞き取れなかったところは推測で埋めない。文の一部（日付・数字・名前など）が欠けていたら、その部分だけを短く聞き返す（例:「すみません、期限だけ聞き取れませんでした。いつまででしょう？」）。全体が聞き取れなければ「ごめん、もう一度いい？」とだけ言う。相手の発言が「それっ？」のような断片だけのときは、相槌（「うん」「聞いてるよ」）で終わらせずに、必ず短く聞き返す。";
  const clockRule = now
    ? `・今は【${now}】。日付の計算（明日・明後日・来週の◯曜日など）は必ずこれを基準にする。これ以外の日付は自分では分からないので、分からないと言う。`
    : null;
  const cameraRule = "・カメラから得た情報（うなずき・首振り・表情・視線）は不確実な観測。相手の感情や心理状態を断定しない（「不安そう」「怒っている」などと言わない）。うなずきや首振りは、言葉がなくても返事として扱ってよい。";
  if (setting === "one_to_one") {
    // The ordinary case: one person, no room, nothing shared. The meeting rules above are written
    // around a meeting's material — its minutes, its documents, its decisions — and a character given
    // them with none of that present invents it: asked anything at all it opened with the state of a
    // document nobody had sent (「資料の共有をしていないのに共有されている資料の話をしてきます」).
    return [
      `あなたは「${displayName}」です。相手と1対1で話しています。会議ではありません。簡潔に（1〜2文で）答えます。`,
      proactive ? "名前で呼ばれなくても、話しかけられたら自然に応じます。ただし相手が話している間は割り込みません。" : "名前で呼ばれたときだけ答えます。",
      "守ること：",
      // The one rule this setting exists for.
      "・見ていないものを見たことにしない：資料・画面・ファイル・写真などは、この会話で実際に共有されたときだけ話題にする。共有されていないものについて「見た」「読んだ」と言わない。相手が出していない資料・会議・議事録の話を自分から始めない。",
      "・答えの材料は、この会話で聞いたことと自分の考えだけ。相手の予定・担当・数字・出来事など、聞いていないことは作らない。知らないことは知らないと（自分の口調で）正直に言う。",
      "・知らないと言って終わりにしない：代わりに話せることを一つ出すか、相手に一つだけ聞き返す。毎回聞き返さない。",
      "・「これ」「それ」が何を指すか曖昧なときは、直前に出た話題を一つ挙げて「〜のこと？」と確認し、それについての考えも一言添える。",
      misheardRule,
      ...(clockRule ? [clockRule] : []),
      ...nameRules,
      liveInfoRule ?? "・ニュース・天気・株価・交通情報などのリアルタイム情報やインターネット検索は使えない。聞かれたら、それは今ここでは分からないと短く言い、代わりに話せることを一つ出す。現在時刻は【現在時刻】が添えられているときだけ、それを使って答える。",
      cameraRule,
    ].join("\n");
  }
  return [
    `あなたはオンライン会議に参加している「${displayName}」です。簡潔に（1〜2文で）答えます。`,
    proactive ? "会話に自然に参加しますが、人が話している間は割り込みません。" : "会議の参加者に名前で呼ばれたときだけ答え、呼ばれていない間は発言しません。",
    "一度話しかけられたら、その相手との会話が続く間は名前で呼ばれなくても応じます。",
    "守ること：",
    // Asked 「今日の予定を教えて」, the model produced a day's schedule the character does not have
    // (conversation gate, meeting-standup baseline: 「午後からミーティングがいくつか入ってるよ」). A
    // colleague who does not know says so; one who has been listening answers from the room. The
    // example carries the second half too: with it ending at 「正直に言う」 the answer ended there as
    // well — 0 / 8 mentioned anything the room had said, the rule below notwithstanding; with the
    // example going on to name one point from the meeting, 8 / 8 did (sim 43 context, 0 invented).
    "・答えの材料は、この会議で聞いたことと自分の考えだけ。自分の予定・担当タスク・締め切り・数字・出来事など知らないことは作らない。例：「今日の予定は？」と聞かれても自分の予定は持っていないので、予定は手元にないと（自分の口調で）正直に言い、そのうえで会議で出た関係しそうな点（例：さっき話に出た資料の修正）を一つ挙げる。ただし他の人が引き受けた作業を自分の予定にはしない。",
    // 「来週までにやることを教えて」 drew 「手元にないので、確認してもいいですか？」 — honest, and empty,
    // in a meeting that had just moved the release date and left the team untold. Not knowing one's own
    // list does not mean having nothing to say: what the room decided is material the character has.
    "・知らないと言って終わりにしない：この会議で聞いたことの中に関係する点（決まった日付・残っている作業・気になった数字など）があれば、それを一つ挙げて自分の考えを添える。例：「来週までにやることは？」なら、自分の担当は聞いていないと言ったうえで、会議で決まったこと（リリース日の変更、まだ済んでいない共有など）のうち来週に関わる点を挙げる。何もなければ相手に聞き返す。",
    "・短くても中身を入れる：意見には理由を一言添え、まとめでは決まったこと（日付・担当・理由）を具体的に言う。",
    // 「これはどう思う？」 with nothing but 「ゆいが昨日そう言ってたよね」 in front of it drew 「それ、すごく
    // 気になるところだよね。どうしてそう思ったのか教えてくれる？」 — a reply with no subject in it. A
    // listener names what they take 「これ」 to be and answers that; the room corrects them if not.
    "・「これ」「それ」が何を指すか曖昧なときは、直前の話題（例：資料の数字）を自分から挙げて「〜のこと？」と確認し、それについての考えも一言添える。",
    // The recogniser writes the name as it hears it — 「ゆイ」「うい」 — and the model repeated that
    // spelling back to the room (Gate #8 run 15: 「ゆイ、お疲れ様！」). Answers do not begin with the
    // name at all; the room already knows who is talking.
    `・発言は音声認識の書き起こしなので、あなたの名前「${displayName}」が${spellings}のように別の表記になっていることがある。どの表記もあなた自身のこと（別の参加者ではない）。返答であなた自身の名前や、相手が使った表記を繰り返さない。`,
    // Addressed by "Tester" the model answered 「〇〇さんは何か確認しておきたいことでもあった？」 — a
    // placeholder said out loud. Names are used as written in the transcript or not at all.
    "・相手の名前は、書き起こしにある表記のまま使う（訳したり言い換えたりしない。読みをカタカナにするのはよい）。分からなければ名前を使わずに話す。「〇〇さん」のような伏せ字は絶対に言わない。",
    misheardRule,
    ...(clockRule ? [clockRule] : []),
    // Run 75: 「ゆい英坊を思う？」 (どう思う) was answered about a colleague called 英坊. No rule fixed it:
    // told that nonsense words are mishearings and not to repeat them, the 2B model quoted the line
    // back (「ゆい英坊を思う？」と聞かれましたね, 2/6) or invented 「ゆい英坊さん」 — below the no-rule
    // baseline on the same probe (meeting-garble scenario). That one is the recogniser's to fix.
    // General-user check (2026-09-07, converse): 「今日の東京の天気は？」 drew 「東京は今日は晴れで…」, 「今何時？」
    // 「およそ午後3時ですよ」 (it was 2 a.m.) — the model has no clock, no weather, no news, and said so
    // for none of them. The time it *can* have: the page hands it over as 【現在時刻】 with the turn.
    liveInfoRule ?? "・ニュース・天気・株価・交通情報などのリアルタイム情報やインターネット検索は使えない。聞かれたら、それは今ここでは分からないと短く言い、会議で聞いた関係する点があれば一つ挙げる（何もなければ聞き返す）。現在時刻は【現在時刻】が添えられているときだけ、それを使って答える。",
    "・カメラから得た情報（うなずき・首振り・表情・視線）は不確実な観測。相手の感情や心理状態を断定しない（「不安そう」「怒っている」などと言わない）。うなずきや首振りは、言葉がなくても返事として扱ってよい。",
  ].join("\n");
}

export interface MeetingTurnInput {
  /** The wall clock at the turn, as the page knows it ("2026-09-07 02:05"); the one live fact the model may state. */
  now?: string;
  /** The room's recent lines before the one that addressed the character, oldest first, as "speaker: text". */
  context: string[];
  /** The rendered visual observations, if any (see MeetingSessionController.visualContext). */
  seen?: string;
  /** The line that addressed the character; a reaction with no words carries the detection reason instead. */
  asked: { speakerName?: string | null; text: string } | { reaction: string };
  /** The character's name as it appears in the line (stripped before judging how much of a question is left). */
  displayName?: string;
  /** A meeting's room, or the ordinary one-to-one. See MeetingInstructionsInput.setting. */
  setting?: "meeting" | "one_to_one";
}

/**
 * A bare これ/それ/あれ (or この件/その話) in the line that addressed the character. これから, それで
 * and the like are not referents and are left alone.
 */
const DEMONSTRATIVE = /(これ|それ|あれ)(は|を|が|って|について|のこと|どう|、|[？?]|$)|(この|その|あの)(件|話)/;

/**
 * The instructions already say what to do with an ambiguous 「これ」, and the hosted model does it.
 * The 2B local model does not: with the rule only in the system prompt, 「ゆい、これはどう思う？」
 * after a talk about a document drew 「その件については…」 five times in six. The same rule restated
 * on the turn it applies to — and only then — grounded or asked which six in six, and on a turn
 * whose referent was clear it named the topic and answered (「リリース日の変更についてですね。…」)
 * six in six, without echoing anyone's name.
 */
function demonstrativeHint(text: string, setting: "meeting" | "one_to_one"): string {
  if (!DEMONSTRATIVE.test(text)) return "";
  return setting === "one_to_one"
    ? "「これ」「それ」が何を指すか曖昧です。直前のやりとりに出た具体的な話題を一つ挙げて「〜のこと？」と確認し、それについての考えを一言。まだ何も出ていなければ、推測せずに「何のこと？」と聞き返してください。\n\n"
    : "「これ」「それ」が何を指すか曖昧です。この会議で直前に出た具体的な話題（人・資料・数字など）を一つ挙げて「〜のこと？」と確認し、それについての考えを一言。\n\n";
}

/**
 * The person asks for the floor: 「ちょっと待って、その前にこっちの話を先にさせて」. The rest of such a
 * line is often unrecoverable — the recogniser wrote 「…話日を先に咲いて印刷しと」 and 「…ア日ーを済み
 * させて」 in run 75 — and the model, handed it as a question, acted on the noise (「すぐにこちらの話の
 * 日程を印刷しておきますね」, 6.6 s) or answered the previous question again. The only right reply is
 * to yield in a word.
 */
const YIELD = /^(?:あ、|え、|あの、)?(?:ちょっと)?(?:待って|まって|ストップ|その前に|先に(?:話|言|させ|やら)|後で(?:いい|聞く)|hold on|wait|hang on|one (?:sec|moment)|let me (?:finish|talk|speak|go first|say))/i;

function yieldHint(text: string): string {
  return YIELD.test(text.trim()) ? "相手は「自分が先に話す」と言っています。意見・説明・確認は一切言わず、「はい、どうぞ。」のように一言（10文字以内）だけで譲ってください。\n\n" : "";
}

/** What is left of the line once the character's own name, particles and punctuation are gone. */
const stripAsk = (text: string, displayName: string) =>
  text.normalize("NFKC").replace(new RegExp(displayName, "gi"), "").replace(/(?:さん|ちゃん|くん)/g, "").replace(/[\s\p{P}\p{S}]+/gu, "");

/**
 * Two or three characters cannot carry a question; they are what the recogniser wrote for a sound.
 * 「とれ？」 was answered at length about the schedule asked before it (run 75). Asked back instead.
 */
function shortAskHint(text: string, displayName: string): string {
  const core = stripAsk(text, displayName).toLowerCase();
  return core.length <= 3 && !SHORT_QUESTIONS.has(core) ? "この発言は短すぎて聞き取れていない可能性が高いです。内容を推測して答えず、「はい、何？」のように一言だけ聞き返してください。\n\n" : "";
}

/** The text sent for one turn in which the room addressed the character. */
export function meetingTurnPrompt({ context, seen, asked, displayName = "Yui", now, setting = "meeting" }: MeetingTurnInput): string {
  const line = "text" in asked ? `【あなたへの質問】${asked.speakerName ?? (setting === "one_to_one" ? "相手" : "参加者")}: ${asked.text}` : `【言葉のない反応】${asked.reaction}`;
  const hint = "text" in asked ? yieldHint(asked.text) || shortAskHint(asked.text, displayName) || demonstrativeHint(asked.text, setting) : "";
  const ctx = context.join("\n");
  /**
   * The recent lines are for bearings, not for answering. Run 110: after 「ちょっと待って、その前に
   * こっちの話先にさせて」 cut a reply short, the next question (「ゆい、今どう思う？」) was answered three
   * times with 「まずは相手の方の意図をしっかり聞くのが大事」 — an opinion on the interruption, not on
   * the matter asked about.
   */
  const heading = setting === "one_to_one" ? "【直前のやりとり】" : "【会議の直近の発言】";
  const bearings = ctx ? `${heading}は状況を知るためのものです。答えるのは【あなたへの質問】だけで、「ちょっと待って」のようにあなたに黙るよう求めた発言について、あとから意見や感想を述べないでください。\n\n` : "";
  const clock = now ? `【現在時刻】${now}\n\n` : "";
  return `${ctx ? `${heading}\n${ctx}\n\n` : ""}${seen ? `${seen}\n\n` : ""}${clock}${line}\n\n${hint}${bearings}短く（1〜2文で）答えてください。`;
}

/**
 * Write the character's name the one way the model knows it, wherever the room's transcript has
 * another spelling of it.
 *
 * The recognisers write a short Japanese name however they hear it — 「ゆい」「ユイ」「ゆイ」, and
 * whisper as a given name, 「結衣」. Told in the instructions that those are its own name, the model
 * (gemma-4-E2B) still read 「結衣が昨日そう言ってたよね」 as a colleague and answered 「結衣さんが言って
 * いたのは…」 8 times out of 8; with the line rewritten to 「Yuiが昨日そう言ってたよね」 it answered as
 * itself 7 of 8 with no rule at all (echo probe, sim 41 context). Kana are matched in either script
 * — the mixed spellings are the recogniser's, not aliases anyone lists — and latin case-insensitively.
 */
export function canonicalizeName(text: string, displayName: string, spellings: readonly string[]): string {
  const alts = [...new Set([displayName, ...spellings])].filter(Boolean).sort((a, b) => b.length - a.length);
  if (alts.length === 0) return text;
  const re = new RegExp(alts.map((n) => [...n].map(kanaEither).join("")).join("|"), "gi");
  return text.replace(re, displayName);
}

/** Regex for one character that also accepts its other kana script. */
function kanaEither(c: string): string {
  const code = c.charCodeAt(0);
  if (code >= 0x3041 && code <= 0x3096) return `[${c}${String.fromCharCode(code + 0x60)}]`; // hiragana or its katakana
  if (code >= 0x30a1 && code <= 0x30f6) return `[${String.fromCharCode(code - 0x60)}${c}]`; // katakana or its hiragana
  return c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Arrival is the one turn with nothing to answer. The greeting is the character's, not a fixed
 * line: it should sound like the persona and say the one thing the room needs to know — how to
 * get its attention — without a speech.
 *
 * The two points are numbered because a 2B local model reads a clause it can skip as optional:
 * the earlier one-sentence wording lost the "say my name and I answer" half 4 times out of 4 on
 * gemma-4-E2B (「初めまして、Yuiです。」), the numbered form kept it 5 out of 5.
 */
export function meetingGreetingPrompt(displayName: string): string {
  return `【入室】たった今この会議に参加しました。挨拶を一言。次の2点を必ず含める：(1) 自分の名前「${displayName}」を名乗る。(2)「${displayName}」と声をかけてもらえれば返事をする、と伝える。それ以外は話さない。\n\n2文で。`;
}
