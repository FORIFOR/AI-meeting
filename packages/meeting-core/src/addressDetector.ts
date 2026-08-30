/**
 * Decides whether an utterance in a meeting is addressed to the character.
 * Heuristics (documented for the report):
 *  - "addressed": the character's name/alias (or a generic AI vocative) appears AND the utterance is a direct
 *    request/question (question marker, request verb, or a vocative at the start/end), AND it is not a
 *    third-person reference (「〜だろうね」「〜と思ってる」「〜って言ってた」, "said", "thinks", "I wonder if …").
 *  - "invited": no name, but the speaker opens the floor to anyone/AI (「誰か意見ある？」「何か質問は？」,
 *    "any thoughts?", "AIに聞いてみよう").
 *  - neither: everything else (the character keeps observing).
 */
export interface AddressDetection {
  addressed: boolean;
  invited: boolean;
  /** 0..1 */
  confidence: number;
  reason: string;
}

export interface AddressDetectorOptions {
  /** Character name + aliases (any script). */
  names: string[];
  /** Extra generic vocatives that count as addressing the AI. Defaults cover JP/EN. */
  aiVocatives?: string[];
}

const DEFAULT_AI_VOCATIVES = ["AIさん", "AIちゃん", "アシスタント", "ボット", "bot", "assistant", "the AI", "AI"];

const JP_QUESTION = /(？|\?|ですか|ますか|でしょうか|かな[ぁあ]?[。]?$|どう思(う|います)|どうですか|どうかな|教えて|説明して|お願い(し|でき)|できますか|してくれ(る|ますか)|してもらえ|いかがですか|意見(を|は|ある)|どう(かな|でしょう)|なんだと思)/;
const EN_QUESTION = /(\?|what do you think|your thoughts|could you|can you|would you|please|tell (us|me)|explain|what('s| is) your (take|opinion|view)|do you (think|agree)|any (ideas|thoughts)|how about you|thoughts\b|weigh in)/i;
const JP_THIRD_PERSON = /(だろう(ね|な|か)?[。]?$|と思(う|って(る|いる|た))|って言って(た|ました)|らしい(よ|ね|です)?[。]?$|みたい(だ|です)ね?[。]?$|のこと(を|が|は)|について話|には聞いて(ない|いない)|に聞いた|が言(った|ってた))/;
const EN_THIRD_PERSON = /\b(said|says|thinks|thought|told|mentioned|I wonder (if|whether|what)|wonder what)\b/i;
const JP_INVITE = /(誰か(意見|質問|コメント)|何か(意見|質問|ある(人|方))|皆さん(どう|意見)|他に(意見|質問)|AIに(聞|訊)いて|聞いてみ(よう|ましょう)|どなたか)/;
const EN_INVITE = /(anyone|anybody|any (questions|thoughts|ideas|comments)|let'?s ask (the )?ai|open the floor|does anyone)/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class AddressDetector {
  private readonly nameRe: RegExp;
  private readonly vocativeStartRe: RegExp;
  private readonly vocativeEndRe: RegExp;
  private readonly aiRe: RegExp;

  constructor(opts: AddressDetectorOptions) {
    const names = opts.names.filter(Boolean).map(escapeRe);
    if (names.length === 0) throw new Error("AddressDetector needs at least one name");
    const alt = `(?:${names.join("|")})`;
    this.nameRe = new RegExp(alt, "i");
    // 「Yui、」「Yuiさん、」「ねえYui」「Hey Yui,」「Yui!」 at the start; 「…、Yui？」「…, Yui?」 at the end.
    // Either "<greeting> Name" or "Name<punctuation>" — a bare "Name <verb>" ("Yui said …") is narration, not a vocative.
    this.vocativeStartRe = new RegExp(`^(?:(?:ねえ|ねぇ|なあ|hey|hi|ok|okay|えっと|あの)[\\s,、]*${alt}(?:さん|ちゃん|くん|先生)?\\b|${alt}(?:さん|ちゃん|くん|先生)?[,、。！!？?:：])`, "i");
    this.vocativeEndRe = new RegExp(`[,、\\s]${alt}(?:さん|ちゃん)?[\\s。！!？?]*$`, "i");
    const ai = (opts.aiVocatives ?? DEFAULT_AI_VOCATIVES).map(escapeRe);
    this.aiRe = new RegExp(`(?:^|[\\s,、])(?:${ai.join("|")})(?:さん|ちゃん)?(?:[\\s,、。！!？?:：]|$)`, "i");
  }

  detect(rawText: string): AddressDetection {
    const text = rawText.trim();
    if (!text) return { addressed: false, invited: false, confidence: 0, reason: "empty" };
    const hasName = this.nameRe.test(text);
    const hasAi = this.aiRe.test(text);
    const vocative = this.vocativeStartRe.test(text) || this.vocativeEndRe.test(text);
    const question = JP_QUESTION.test(text) || EN_QUESTION.test(text);
    const thirdPerson = JP_THIRD_PERSON.test(text) || EN_THIRD_PERSON.test(text);
    const invite = JP_INVITE.test(text) || EN_INVITE.test(text);

    if (hasName || hasAi) {
      if (thirdPerson && !vocative) return { addressed: false, invited: false, confidence: 0.3, reason: "name mentioned in third person" };
      if (vocative) return { addressed: true, invited: false, confidence: question ? 0.95 : 0.8, reason: "vocative" };
      if (question) return { addressed: true, invited: false, confidence: 0.85, reason: "name + question/request" };
      return { addressed: false, invited: false, confidence: 0.4, reason: "name mentioned without a request" };
    }
    if (invite) return { addressed: false, invited: true, confidence: 0.6, reason: "floor opened" };
    return { addressed: false, invited: false, confidence: 0.1, reason: "not addressed" };
  }
}
