/**
 * Turn Endpoint Policy (Round 3, Gate 4).
 * Ends a user turn from VAD silence *and* what was said: a linguistically complete utterance
 * ends after a short silence, an obviously unfinished one (trailing particle, filler, dangling
 * enumeration) waits much longer. Pure and clock-free so it is unit-testable.
 */
export interface Completeness {
  /** 0 = clearly continuing, 1 = clearly finished. */
  score: number;
  reason: string;
}

const JA_FINAL = /(です|ます|でした|ました|ません|ませんでした|ください|でしょうか|でしょう|ですか|ますか|ですね|ますね|ですよ|ますよ|かな|よね|だよ|だね|だった|と思います|と思う|んです|んだ|んですよ|のです|たい|たいです|ない|なかった|ません|ましょう|ましょうか|ください|なさい|だろう|でしょ|ください)$/;
const JA_PLAIN_PAST = /(った|んだ|いた|えた|きた|した|ちた|にた|びた|みた|りた|った|た|る|う|く|ぐ|す|つ|ぬ|ぶ|む)$/; // plain verb endings: moderately complete
const JA_CONT = /(が|けど|けれど|けれども|て|で|し|から|ので|のに|と|や|に|を|は|も|へ|たら|なら|ば|ながら|つつ|とか|って|の|、|,)$/;
const JA_FILLER = /(えっと|えーと|ええと|えー|あの|あのー|あのう|その|そのー|うーん|うん|んー|なんか|まあ|まぁ|ま|あー|えと)$/;
const JA_QUESTION = /(か|かな|でしょうか|ますか|ですか|の)[？?]?$/;
const NUM_TAIL = /([0-9０-９]|[一二三四五六七八九十百千万億]|、)$/;
const EN_CONT = /\b(and|but|so|because|or|then|which|that|to|of|in|with|for|if|when|while|although|the|a|an)$/i;
const EN_FILLER = /\b(um|uh|like|well|hmm|er|erm|you know)$/i;

/**
 * ASR normalisation: offline recognisers (SenseVoice) insert spaces between tokens and append a
 * terminal 。/？ to EVERY segment, including mid-sentence pauses ("ので。", "私は？"). Terminal
 * punctuation is therefore only a weak cue; the decision rests on the linguistic ending.
 */
export function normalizeAsrText(raw: string): { text: string; terminal: string } {
  const cjk = /[぀-ヿ一-鿿]/.test(raw);
  const noSpace = cjk ? raw.replace(/[\s\u3000]+/g, "") : raw.replace(/\s+/g, " ").trim();
  const m = noSpace.match(/[。．.、,？?！!…]+$/);
  return { text: m ? noSpace.slice(0, noSpace.length - m[0].length) : noSpace, terminal: m ? m[0] : "" };
}

export function assessCompleteness(rawText: string, language = "ja", opts: { trustPunctuation?: boolean } = {}): Completeness {
  const raw = rawText.trim();
  if (!raw) return { score: 0.3, reason: "empty" };
  const ja = language.toLowerCase().startsWith("ja") || /[぀-ヿ一-鿿]/.test(raw);
  const { text, terminal } = normalizeAsrText(raw);
  if (!text) return { score: 0.3, reason: "empty" };
  if (opts.trustPunctuation && /[。！？!?]/.test(terminal.slice(-1))) return { score: 0.95, reason: "punct" };
  if (!ja && /[.!?]$/.test(terminal)) return { score: 0.95, reason: "punct" };
  const questionMark = /[？?]$/.test(terminal);
  if (ja) {
    const t = text.replace(/[「」『』（）()]+$/g, "");
    if (JA_FILLER.test(t)) return { score: 0.1, reason: "filler" };
    if (JA_CONT.test(t) && !JA_FINAL.test(t)) return { score: 0.15, reason: "trailing_particle" };
    if (NUM_TAIL.test(t)) return { score: 0.25, reason: "dangling_number" };
    if (JA_FINAL.test(t)) return { score: 0.85, reason: "final_form" };
    if (JA_QUESTION.test(t)) return { score: 0.8, reason: "question" };
    if (JA_PLAIN_PAST.test(t)) return { score: 0.65, reason: "plain_verb" };
    return { score: questionMark ? 0.6 : 0.5, reason: questionMark ? "unknown_question_mark" : "unknown" };
  }
  if (EN_FILLER.test(text)) return { score: 0.1, reason: "filler" };
  if (EN_CONT.test(text)) return { score: 0.15, reason: "trailing_conjunction" };
  if (/[,;:]$/.test(terminal)) return { score: 0.2, reason: "dangling_punct" };
  if (/\b(am|is|are|was|were|will|can|could|should|would|do|does|did|have|has|had)\b.*$/i.test(text) && text.split(/\s+/).length >= 3) return { score: 0.6, reason: "clause" };
  return { score: 0.5, reason: "unknown" };
}

export interface EndpointPolicyOptions {
  /** Silence required when the text is complete AND stable (ms). */
  minSilenceMs?: number;
  /** Silence required when complete but the transcript is still moving (ms). */
  completeSilenceMs?: number;
  /** Silence required when completeness is unknown (ms). */
  unknownSilenceMs?: number;
  /** Silence required when the text is clearly unfinished (ms). */
  incompleteSilenceMs?: number;
  /** Below this, the acoustic model is saying "still talking" and the wait is extended. Default 0.3. */
  acousticIncompleteBelow?: number;
  /** Extra silence required while the acoustic model says the turn is unfinished (ms). Default 500. */
  acousticHoldMs?: number;
  /** Hard cap: always end after this much silence (ms). */
  maxSilenceMs?: number;
  /** Adaptive offset added after a premature endpoint (ms), its cap, and the per-clean-turn decay. */
  adaptStepMs?: number;
  adaptCapMs?: number;
  decayMs?: number;
  decayAfterCleanTurns?: number;
  language?: string;
}

export interface EndpointInput {
  /** True while the VAD still reports speech (no endpoint is possible). */
  speaking: boolean;
  /** Silence since the last speech sample (ms). */
  silenceMs: number;
  /** Best transcript so far (partial or final decode). */
  text: string;
  /** The tail of the transcript did not change between the last two decodes. */
  stable: boolean;
  /**
   * Acoustic turn-completeness, 0..1, from Smart Turn v3 — absent when the model is not loaded.
   *
   * It is only ever allowed to make the agent wait longer. Measured on a real meeting recording the
   * model separates end-of-utterance from mid-utterance in the right direction but with low absolute
   * values on far-field audio, so treating it as authority to cut early would trade a patient agent
   * for one that interrupts. Used as a veto, a mis-calibrated model costs a little latency and
   * nothing else.
   */
  acoustic?: number;
}

export interface EndpointDecision {
  decision: "continue" | "endpoint" | "soft_endpoint";
  reason: string;
  /** ms until the decision should be re-evaluated (0 when ending). */
  waitMs: number;
  requiredSilenceMs: number;
  completeness: number;
}

export class EndpointPolicy {
  private readonly o: Required<EndpointPolicyOptions>;
  private offsetMs = 0;
  private cleanStreak = 0;
  readonly stats = { endpoints: 0, premature: 0 };

  constructor(opts: EndpointPolicyOptions = {}) {
    this.o = {
      minSilenceMs: opts.minSilenceMs ?? 240,
      completeSilenceMs: opts.completeSilenceMs ?? 320,
      unknownSilenceMs: opts.unknownSilenceMs ?? 520,
      incompleteSilenceMs: opts.incompleteSilenceMs ?? 800,
      maxSilenceMs: opts.maxSilenceMs ?? 900,
      adaptStepMs: opts.adaptStepMs ?? 80,
      adaptCapMs: opts.adaptCapMs ?? 500,
      decayMs: opts.decayMs ?? 20,
      decayAfterCleanTurns: opts.decayAfterCleanTurns ?? 3,
      language: opts.language ?? "ja",
      acousticIncompleteBelow: opts.acousticIncompleteBelow ?? 0.3,
      acousticHoldMs: opts.acousticHoldMs ?? 500,
    };
  }

  /** Current adaptive offset (grows after premature endpoints, decays after clean ones). */
  get adaptiveOffsetMs(): number {
    return this.offsetMs;
  }

  requiredSilence(text: string, stable: boolean): { ms: number; reason: string; completeness: number } {
    const c = assessCompleteness(text, this.o.language);
    let base: number;
    let reason: string;
    if (c.score >= 0.8) {
      base = stable ? this.o.minSilenceMs : this.o.completeSilenceMs;
      reason = c.reason;
    } else if (c.score >= 0.4) {
      base = this.o.unknownSilenceMs;
      reason = c.reason;
    } else {
      base = c.reason === "filler" ? this.o.maxSilenceMs : this.o.incompleteSilenceMs;
      reason = c.reason;
    }
    return { ms: Math.min(this.o.maxSilenceMs, base + this.offsetMs), reason, completeness: c.score };
  }

  evaluate(input: EndpointInput): EndpointDecision {
    if (input.speaking) return { decision: "continue", reason: "speaking", waitMs: 0, requiredSilenceMs: 0, completeness: 0 };
    const req = this.requiredSilence(input.text, input.stable);
    /**
     * The acoustic model only ever buys time. 「えーっと、それは……」 is a complete-looking phrase with
     * a pause in it, and text alone reads it as a finished turn — this is the case the model exists for.
     * It cannot shorten a wait, so a wrong reading costs latency, never an interruption.
     */
    const holding = typeof input.acoustic === "number" && input.acoustic < this.o.acousticIncompleteBelow;
    if (holding) {
      req.ms = Math.min(this.o.maxSilenceMs + this.o.acousticHoldMs, req.ms + this.o.acousticHoldMs);
      req.reason = `${req.reason}+acoustic_incomplete`;
    }
    const hardCap = this.o.maxSilenceMs + (holding ? this.o.acousticHoldMs : 0);
    if (input.silenceMs >= hardCap) return { decision: "endpoint", reason: "max_silence", waitMs: 0, requiredSilenceMs: hardCap, completeness: req.completeness };
    if (input.silenceMs >= req.ms) return { decision: "endpoint", reason: req.reason, waitMs: 0, requiredSilenceMs: req.ms, completeness: req.completeness };
    const wait = Math.max(10, req.ms - input.silenceMs);
    const soft = req.completeness >= 0.8 && input.silenceMs >= req.ms * 0.6;
    return { decision: soft ? "soft_endpoint" : "continue", reason: req.reason, waitMs: wait, requiredSilenceMs: req.ms, completeness: req.completeness };
  }

  /** The user resumed right after we ended the turn: wait longer from now on. */
  notePrematureEndpoint(): void {
    this.stats.premature++;
    this.cleanStreak = 0;
    this.offsetMs = Math.min(this.o.adaptCapMs, this.offsetMs + this.o.adaptStepMs);
  }

  /** A turn ended and the user did not resume: slowly relax. */
  noteCleanEndpoint(): void {
    this.stats.endpoints++;
    this.cleanStreak++;
    if (this.cleanStreak >= this.o.decayAfterCleanTurns) {
      this.cleanStreak = 0;
      this.offsetMs = Math.max(0, this.offsetMs - this.o.decayMs);
    }
  }
}
