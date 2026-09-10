import { MEETING_PERSONA_ID } from "./meetingPrompt.js";
import { AddressDetector, type AddressDetection } from "./addressDetector.js";
import type { VisualCue } from "@rcai/visual-core";

/**
 * ParticipationPolicy: the character never barges into a meeting.
 *   OBSERVING → LISTENING (someone is speaking) → ADDRESSED (directly asked / invited) → RESPONDING → OBSERVING.
 * Pure state machine; the session controller decides how to gate audio to the AI provider from `state`.
 */
export type ParticipationState = "OBSERVING" | "LISTENING" | "ADDRESSED" | "RESPONDING";

/**
 * Whether the character is currently in a conversation, and with whom.
 *
 * Addressing answers "was this turn for me". Engagement answers "am I still in this". Without the
 * second layer every single turn has to carry the name — 「ゆい、なんで？」「ゆい、例えば？」 — which
 * nobody does when talking to a person. Once someone calls the character by name, their following
 * turns count as addressed until the conversation moves on.
 */
export type EngagementState = "PASSIVE" | "ENGAGED" | "YIELDING" | "COOLDOWN";

export interface Engagement {
  /** Who the character is talking with. Identity first, display name as the fallback. */
  participantId: string;
  startedAt: number;
  lastTurnAt: number;
  expiresAt: number;
}

/**
 * How much the character needs before it speaks.
 *
 *   addressed_only  its name, used as a vocative or with a request
 *   invited         also when the floor is opened to anyone (「誰か意見ある？」)
 *   active          also a question nobody answered, once the room falls quiet
 *   open            also ordinary conversation — it joins in without being called
 *
 * `open` is a different social contract, not a louder `active`: the character takes a turn in a
 * conversation that was not directed at it. Companion calls want it; a meeting of colleagues usually
 * does not. The cooldown and the consecutive cap still hold, and it still waits for the room to go
 * quiet, so it takes turns rather than talking over people.
 */
export type Proactivity = "addressed_only" | "invited" | "active" | "open";

/**
 * How forward the character is by default, decided by what the conversation is.
 *
 * One person talking to the character is the ordinary case: they look at it and speak, and waiting to
 * be called by name each time is not conversation, it is a summons. A meeting is the exception —
 * several people talking to each other, where answering everything said in the room is the failure
 * mode — so the meeting persona keeps `addressed_only` and everything else opens up. An operator or a
 * bot page may still pass its own; this is only the default when none is given.
 */
export function defaultProactivityFor(input: { personaId?: string | null; mode?: string | null }): Proactivity {
  const meeting = input.personaId === MEETING_PERSONA_ID || input.mode === "meeting";
  return meeting ? "addressed_only" : "open";
}

export interface ParticipationPolicyOptions {
  names: string[];
  /** Mishearings of the name that still count as an utterance-initial call (see AddressDetector). */
  soundalikes?: string[];
  proactivity?: Proactivity;
  /** After a response, ignore new triggers for this long (ms). Default 4000. */
  cooldownMs?: number;
  /** Max responses in a row without another participant addressing someone else. Default 2. */
  maxConsecutiveResponses?: number;
  /** LISTENING falls back to OBSERVING after this much silence (ms). Default 2500. */
  silenceGapMs?: number;
  /** In "active" mode, respond to any question once the room has been silent this long (ms). Default 1800. */
  activeSilenceMs?: number;
  /** How long the floor stays with a person after they stop speaking (ms). Default 700. */
  yieldGraceMs?: number;
  /**
   * Treat a clear visual reaction from the person the character is talking with as a turn: a nod is an
   * answer, and a head shake or a tilt is a request to say it differently. Only inside an engaged
   * conversation — reacting to a nod from someone who never spoke to the character is a machine
   * watching a room, which is a different product and not this one. Default true.
   */
  visualTurns?: boolean;
  /**
   * In "open" mode, an utterance shorter than this many characters is treated as a backchannel
   * (「うん」「はい」「Yeah.」) and does not earn a turn. Default 6.
   */
  openMinChars?: number;
  /**
   * How long an engaged follow-up whose text opens with a fragment waits for the recogniser's second
   * reading before it is answered (ms). Run 109: 「ゆいが昨日そう言ってたよね」 reached the streaming
   * recogniser as 「いいが、昨日そう言ってたよね。」 — the name gone into a hole — and was answered as a
   * follow-up 1.1 s before the rescore restored the name and the third person. 0 disables.
   */
  fragmentHoldMs?: number;
  detector?: AddressDetector;
  /**
   * How recently the room must have spoken for a provider-decided turn (`acceptSelfTurn`) to count as
   * an answer to it. Beyond this the provider is talking to itself. Default 15 s.
   */
  selfTurnWindowMs?: number;
  /** Names that identify the character itself (its own transcript is ignored). */
  selfNames?: string[];
  /**
   * How long a conversation stays open without a turn from the person the character is talking with.
   * Default 90 s: long enough that a pause, a sip of coffee or someone else's aside does not end it,
   * short enough that a meeting which has moved on does not leave the character believing it is
   * still in a conversation. 0 disables the layer entirely (every turn needs the name again).
   */
  engagementTtlMs?: number;
  /**
   * How many answers in a row may be cut off before the character stops volunteering follow-ups.
   *
   * An open mic carrying someone's continuous talk — a person, a video playing beside them — reached
   * the character as one "follow-up" after another, and it started an answer to each and was cut off
   * every time: fifteen half-sentences in three minutes (Gate #8 run 44). Someone talked over that
   * many times is not being spoken to. After this many interruptions the engagement ends; the name
   * re-opens it. A completed answer resets the count. Default 3; 0 disables.
   */
  maxInterruptedInARow?: number;
  /**
   * How long a greeting waits for the room to go quiet before it is dropped (ms).
   *
   * Let in while the room was talking, the character held its hello for 70 s and then delivered it
   * into the middle of a question addressed to it (Gate #8 run 45). Someone who joins a busy meeting
   * says hello in the first pause or not at all. Default 30 s; 0 never drops it.
   */
  greetingTtlMs?: number;
}

export interface TranscriptSegment {
  text: string;
  final: boolean;
  speakerName?: string | null;
  participantId?: string;
}

export interface PolicyTransition {
  from: ParticipationState;
  to: ParticipationState;
  at: number;
  reason: string;
}

/** `addressedBy.detection.reason` for the one turn the character takes without being spoken to. */
export const JOINED_REASON = "joined the meeting";
/**
 * The reason a turn carries when the AI's own provider decided to answer. Speech-to-speech providers
 * (Gemini Live) do their own endpointing and start replying about a second after the room stops; the
 * page's own decision arrives later, so a reply cut for being unsanctioned was every reply the
 * character had (2026-09-07, one-to-one on Gemini: 48 transcripts, 0 answers). The page recognises
 * this reason and does not ask for the answer a second time.
 */
export const SELF_TURN_REASON = "answered on its own";

/** Acknowledgements, in the languages a room mix gets transcribed into — none of them is a turn. */
const BACKCHANNELS = new Set([
  "うん", "ううん", "はい", "ええ", "へえ", "そう", "そうそう", "そうね", "そうだね", "なるほど", "ふーん", "ふうん", "おっけー", "おけ", "いいね", "いいよ", "了解", "りょうかい", "あー", "えー", "んー",
  "ok", "okay", "yes", "yeah", "yep", "no", "nope", "right", "sure", "great", "good", "nice", "cool", "fine", "hmm", "hm", "mm", "mhm", "uh", "um", "oh", "ah", "wow", "thanks", "thank you",
  "嗯", "好", "好的", "对", "是", "你", "你好", "谢谢",
]);

/**
 * A sentence that starts where a sentence does not: on punctuation, on a one-to-three-kana word cut off
 * by a comma, or on a particle. Where the streaming recogniser lost its first mora to a hole.
 */
export function opensWithFragment(text: string): boolean {
  const t = text.trim();
  return /^(?:[、。,.]|[ぁ-んァ-ンー]{1,3}[、,]|[がはをにへとでも](?![ぁ-んァ-ン]))/.test(t);
}

/**
 * A follow-up is a sentence, not a noise. The recogniser writes a single word — in whatever
 * language the sound resembled most — for a cough or a chair over an open mic, and an engaged
 * character answered 「你。」「Great.」「Okay.」 in a room where nobody had spoken (Gate #8 run 14).
 * Punctuation is stripped; what remains must be at least three characters long and not an
 * acknowledgement. A real 「なんで？」 or "Why?" clears both bars.
 */
export function isFollowUpWorthy(text: string): boolean {
  const core = text.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  if (core.length < 3 && !(/[?？]/.test(text) && SHORT_QUESTIONS.has(core))) return false;
  return !BACKCHANNELS.has(core);
}

/**
 * The short questions a person actually asks in one or two characters. The question mark alone
 * used to be enough, and the recogniser puts one on noise as readily as on a word: 「とれ？」 (run 75,
 * a misheard 「ゆい、今日の予定は？」) was answered in full, about a colleague called とれ.
 */
export const SHORT_QUESTIONS = new Set([
  "何", "なに", "なん", "なぜ", "なんで", "どこ", "誰", "だれ", "いつ", "どう", "どれ", "どっち", "どちら", "え", "ん", "は",
  "why", "how", "who", "what", "where", "when", "which", "hm", "huh", "eh", "so",
]);

export class ParticipationPolicy {
  private _state: ParticipationState = "OBSERVING";
  /** The current turn is the greeting on arrival: not a response, so it spends neither cooldown nor cap. */
  private greeting = false;
  /** Arrived while someone was speaking: the greeting waits for the next silence (`tick`). */
  private greetingPending = false;
  /** When the pending greeting stops being worth saying (see `greetingTtlMs`). */
  private greetingExpiresAt = Infinity;
  private readonly detector: AddressDetector;
  private readonly opts: Required<Omit<ParticipationPolicyOptions, "detector" | "selfNames" | "soundalikes">> & { selfNames: string[] };
  private lastSpeechAt = -1e9;
  private lastResponseEndAt = -1e9;
  private consecutive = 0;
  private pendingQuestion: { text: string; at: number; key: string | null; speakerName?: string | null } | null = null;
  /** The last thing the room actually said: what a provider-decided turn is an answer to. */
  private lastFinal: { text: string; at: number; key: string | null; speakerName?: string | null } | null = null;
  /** An engaged follow-up that opened with a fragment, waiting for the second reading (or `fragmentHoldMs`). */
  private heldFollowUp: { seg: TranscriptSegment; key: string | null; at: number; detection: AddressDetection } | null = null;
  /** Called by name while the character was already speaking (see `onTranscript`): answered next. */
  private heldAddress: { seg: TranscriptSegment; detection: AddressDetection } | null = null;
  private history: PolicyTransition[] = [];
  private listeners = new Set<(t: PolicyTransition) => void>();
  /** The utterance that triggered ADDRESSED (for the assistant's context). */
  addressedBy: { text: string; speakerName?: string | null; detection: AddressDetection } | null = null;
  private engagement: Engagement | null = null;
  /** Answers cut off since the last one that finished (see `maxInterruptedInARow`). */
  private interruptedInARow = 0;
  private yieldingUntil = -Infinity;
  private lastTickAt = 0;

  constructor(options: ParticipationPolicyOptions) {
    this.opts = {
      names: options.names,
      proactivity: options.proactivity ?? "addressed_only",
      cooldownMs: options.cooldownMs ?? 4000,
      maxConsecutiveResponses: options.maxConsecutiveResponses ?? 2,
      silenceGapMs: options.silenceGapMs ?? 2500,
      activeSilenceMs: options.activeSilenceMs ?? 1800,
      openMinChars: options.openMinChars ?? 6,
      selfTurnWindowMs: options.selfTurnWindowMs ?? 15_000,
      fragmentHoldMs: options.fragmentHoldMs ?? 2500,
      visualTurns: options.visualTurns ?? true,
      yieldGraceMs: options.yieldGraceMs ?? 700,
      selfNames: options.selfNames ?? options.names,
      engagementTtlMs: options.engagementTtlMs ?? 90_000,
      maxInterruptedInARow: options.maxInterruptedInARow ?? 3,
      greetingTtlMs: options.greetingTtlMs ?? 30_000,
    };
    this.detector = options.detector ?? new AddressDetector({ names: options.names, soundalikes: options.soundalikes });
  }

  get state(): ParticipationState {
    return this._state;
  }

  onTransition(cb: (t: PolicyTransition) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getHistory(): PolicyTransition[] {
    return [...this.history];
  }

  /** Someone (not the character) started/stopped speaking. */
  onSpeechActivity(active: boolean, now: number, speakerName?: string | null): void {
    if (this.isSelf(speakerName)) return;
    this.lastTickAt = Math.max(this.lastTickAt, now);
    if (active) {
      this.lastSpeechAt = now;
      // The floor is theirs while they hold it, and for a moment after — a gap between two clauses is
      // not an invitation.
      this.yieldingUntil = now + this.opts.yieldGraceMs;
      if (this._state === "OBSERVING") this.transition("LISTENING", now, "speech");
    }
  }

  /**
   * A person started talking while the character was answering.
   *
   * The audio is stopped by the runtime's fast path long before this is called — that is a hard
   * requirement and not a policy decision. What the policy does is remember that the character was
   * cut off: the conversation is still open, the floor is not.
   */
  onInterrupted(now: number): void {
    this.lastTickAt = Math.max(this.lastTickAt, now);
    this.yieldingUntil = now + this.opts.yieldGraceMs;
    // A greeting in progress is over; one still waiting for silence keeps waiting. On a vendor where
    // the AI is the only recogniser, every unsanctioned generation is cut off this way, several times
    // a minute — forgetting the greeting on each would mean never greeting a room that talks.
    this.greeting = false;
    this.addressedBy = null;
    this.pendingQuestion = null;
    // Whoever cut in brings their own transcript; a line held from before the cut is not the next turn.
    this.heldAddress = null;
    // Being cut off does not count as a turn the character took: it did not get to finish one.
    this.consecutive = 0;
    // Cut off this many times in a row, the character was never being listened to: it stops taking
    // follow-ups and waits to be called by name.
    this.interruptedInARow++;
    const talkedOver = this.opts.maxInterruptedInARow > 0 && this.interruptedInARow >= this.opts.maxInterruptedInARow && !!this.engagement;
    if (talkedOver) this.engagement = null;
    if (this._state !== "OBSERVING") this.transition("OBSERVING", now, talkedOver ? "interrupted, talked over" : "interrupted");
  }

  /**
   * The turn just sanctioned was taken on a misreading, and a better reading of the same words says
   * it should not have been. Gate #8 run 78: 「ユが昨日そう言ってたよね。」 lost the name, so it was a
   * follow-up from the person the character was talking with — and the recogniser's rescore 1.9 s
   * later read 「ユイが昨日そう言ってたよね」, talk *about* the character, which a follow-up must never
   * be. Withdrawing is not being interrupted (nobody cut in, the floor stays open, no yield) and not
   * finishing (no cooldown, no consecutive turn): the character simply did not speak. Only while the
   * answer is still being drafted; once it is speaking, the turn stands.
   */
  private takeTurn(seg: TranscriptSegment, key: string | null, d: AddressDetection, now: number, reason: string): void {
    if (d.addressed) this.interruptedInARow = 0;
    this.addressedBy = { text: seg.text, speakerName: seg.speakerName, detection: d };
    this.pendingQuestion = null;
    this.heldFollowUp = null;
    this.engage(key, now);
    if (this._state !== "ADDRESSED") this.transition("ADDRESSED", now, reason);
  }

  /**
   * The second reading of a held follow-up. `was` is the streamed text the hold was taken on; `text`
   * the rescore. Talk about the character drops the hold (no turn was owed); an address takes the turn
   * on the name; any other reading is the follow-up it looked like, answered now with the better words.
   * Returns what happened, or null when nothing was held on those words.
   */
  reviseHeld(was: string, text: string, now: number): "dropped" | "taken" | null {
    const held = this.heldFollowUp;
    if (!held || held.seg.text !== was) return null;
    this.heldFollowUp = null;
    const d = this.detector.detect(text);
    if (!d.addressed && d.reason.startsWith("name mentioned")) return "dropped"; // no turn was owed
    this.takeTurn({ ...held.seg, text }, held.key, d, now, d.addressed ? `${d.reason} (rescore of a held follow-up)` : "engaged follow-up (rescore)");
    return "taken";
  }

  withdraw(now: number, reason: string): boolean {
    if (this._state !== "ADDRESSED") return false;
    this.lastTickAt = Math.max(this.lastTickAt, now);
    this.addressedBy = null;
    this.transition("OBSERVING", now, reason);
    return true;
  }

  /** What the detector reads in a text — a second opinion, without taking a turn on it. */
  detect(text: string): AddressDetection {
    return this.detector.detect(text);
  }

  /** Who the character is in conversation with, if anyone. */
  get engagedWith(): Engagement | null {
    return this.engagement;
  }

  /**
   * PASSIVE   not in a conversation
   * ENGAGED   in one, and it is the character's turn to be spoken to
   * YIELDING  in one, but a person is speaking — the floor is theirs until they stop
   * COOLDOWN  in one, just finished answering — briefly deaf to its own echo and to backchannels
   *
   * The distinction is not cosmetic: YIELDING is what an interruption produces, and a character that
   * cannot tell "I was cut off" from "nobody is talking to me" either restarts the conversation from
   * scratch or keeps talking over the person who cut in.
   */
  get engagementState(): EngagementState {
    if (!this.engagement) return "PASSIVE";
    if (this.yieldingUntil > this.lastTickAt) return "YIELDING";
    if (this.lastTickAt - this.lastResponseEndAt < this.opts.cooldownMs) return "COOLDOWN";
    return "ENGAGED";
  }

  /** Stable-ish identity for a speaker: the vendor's id when there is one, the display name otherwise. */
  private speakerKey(seg: TranscriptSegment): string | null {
    return seg.participantId ?? (seg.speakerName ? `name:${seg.speakerName}` : null);
  }

  private engage(key: string | null, now: number): void {
    if (!key || this.opts.engagementTtlMs <= 0) return;
    this.engagement = {
      participantId: key,
      startedAt: this.engagement?.participantId === key ? this.engagement.startedAt : now,
      lastTurnAt: now,
      expiresAt: now + this.opts.engagementTtlMs,
    };
  }

  private expireEngagement(now: number): void {
    if (this.engagement && now >= this.engagement.expiresAt) this.engagement = null;
  }

  onTranscript(seg: TranscriptSegment, now: number): AddressDetection | null {
    if (this.isSelf(seg.speakerName)) return null;
    this.lastSpeechAt = now;
    if (this._state === "OBSERVING") this.transition("LISTENING", now, "transcript");
    if (this._state === "RESPONDING") {
      // Others talking while we respond: if they address someone else, reset the consecutive counter.
      const d = this.detector.detect(seg.text);
      if (!d.addressed && seg.final) this.consecutive = 0;
      /**
       * Called by name while the character is talking. Speech that overlaps the reply is a barge-in and
       * the session cuts the reply before its transcript lands here; the one that lands *during* the
       * reply is speech that had already ended when the character started — 「ゆい、今日の予定を教えて」
       * finished 0.4 s before the greeting took the floor (offline sims 52, 60), and its transcript
       * arrived mid-greeting to a branch that only counted it. Held, and taken as the next turn the
       * moment this one ends: to the person asking, the character heard them and answered.
       */
      if (d.addressed && seg.final) this.heldAddress = { seg, detection: d };
      return d;
    }
    if (!seg.final) return null;
    const d = this.detector.detect(seg.text);
    /**
     * The cooldown and the consecutive cap keep the character from dominating a room on its own
     * initiative: a follow-up, an invitation, an open-conversation turn. Being called by name is the
     * room's initiative — 「ゆい、今どう思う？」 2.6 s after the character finished (Gate #8 run 46) was
     * dropped by the cooldown, and to the person asking that is a character that does not answer.
     */
    const inCooldown = !d.addressed && now - this.lastResponseEndAt < this.opts.cooldownMs;
    const capped = !d.addressed && this.consecutive >= this.opts.maxConsecutiveResponses;
    if (!d.addressed) {
      // Another participant was addressed / normal chatter → the character is not "on".
      this.consecutive = 0;
    }
    this.expireEngagement(now);
    const key = this.speakerKey(seg);
    this.lastFinal = { text: seg.text, at: now, key, speakerName: seg.speakerName };
    /**
     * A follow-up from the person the character is already talking with. Not a name match, and
     * deliberately not a proactivity tier either: this is the same conversation continuing.
     *
     * Any utterance where the detector saw the name but read it as talk *about* the character
     * (「ゆいがそう言ってた」) is excluded: mid-conversation, describing the character to someone else
     * is the one case where the name appearing means the opposite of a turn. A backchannel earns
     * nothing either.
     */
    const engagedFollowUp =
      !!this.engagement && !!key && this.engagement.participantId === key && !d.addressed && !d.reason.startsWith("name mentioned") && isFollowUpWorthy(seg.text);
    const explicitly = d.addressed || engagedFollowUp;
    const invited = d.invited && (this.opts.proactivity === "invited" || this.opts.proactivity === "active");
    if ((explicitly || invited) && !inCooldown && !capped) {
      /**
       * A follow-up that opens with a fragment — 「、昨日…」「いいが、昨日…」「が昨日…」 — is a sentence
       * whose first mora the recogniser lost, and the mora it lost may have been the name: talk about
       * the character wearing a follow-up's clothes. It waits for the second reading (`reviseHeld`) or
       * `fragmentHoldMs`, whichever is first; a whole sentence is answered as before.
       */
      if (engagedFollowUp && !d.addressed && !invited && this.opts.fragmentHoldMs > 0 && opensWithFragment(seg.text)) {
        this.heldFollowUp = { seg, key, at: now, detection: d };
        return d;
      }
      this.takeTurn(seg, key, d, now, engagedFollowUp && !d.addressed ? "engaged follow-up" : explicitly ? d.reason : "invited");
      return d;
    }
    if (this.opts.proactivity === "active" && !explicitly && !inCooldown && !capped && /[？?]\s*$|ですか|ますか|でしょうか/.test(seg.text)) {
      this.pendingQuestion = { text: seg.text, at: now, key, speakerName: seg.speakerName };
    }
    /**
     * "open": ordinary conversation earns a turn too. Held as a pending turn rather than taken here,
     * so the character still waits for the room to go quiet instead of answering into someone's
     * sentence — the difference between joining a conversation and interrupting one.
     */
    if (this.opts.proactivity === "open" && !explicitly && !inCooldown && !capped && seg.text.trim().length >= this.opts.openMinChars) {
      this.pendingQuestion = { text: seg.text, at: now, key, speakerName: seg.speakerName };
    }
    return d;
  }

  /**
   * A visual reaction from the person the character is talking with.
   *
   * Silence is not always the absence of an answer: after 「Attendee に切り替えた方がいいです」 a nod is
   * the reply, and waiting for words leaves the character talking into a pause that was never empty.
   * The cue is an observation, so what it earns is a turn — never a conclusion about the person.
   */
  onVisualCue(cue: VisualCue, now: number): boolean {
    this.lastTickAt = Math.max(this.lastTickAt, now);
    if (!this.opts.visualTurns || !this.engagement) return false;
    if (cue.participantId !== this.engagement.participantId) return false;
    if (!cue.facePresent || cue.confidence < 0.6) return false;
    if (this.engagementState === "YIELDING") return false; // someone is talking; a nod is not an interruption
    if (this._state === "RESPONDING" || this._state === "ADDRESSED") return false;
    if (now - this.lastResponseEndAt < this.opts.cooldownMs) return false;
    if (this.consecutive >= this.opts.maxConsecutiveResponses) return false;
    const reason = cue.nodded ? "nodded" : cue.shookHead ? "shook head" : cue.tilted && cue.lookingForward > 0.5 ? "head tilted" : null;
    if (!reason) return false;
    this.engage(cue.participantId, now);
    this.addressedBy = {
      text: "",
      detection: { addressed: false, invited: true, confidence: Math.min(0.6, cue.confidence), reason: `visual: ${reason}` },
    };
    this.transition("ADDRESSED", now, `visual: ${reason}`);
    return true;
  }

  /**
   * The character has just been let into the room. A participant who walks in and says nothing is not
   * a participant, and a policy that only ever answers has no other way to let it speak — so arriving
   * is the one turn it takes unasked, in every proactivity tier. Only from idle: if the room is
   * already talking to it the greeting is superfluous, and it never interrupts. It is not a response
   * either — no cooldown, no consecutive turn — so 「ゆい、こんにちは」 straight back gets an answer.
   */
  onJoined(now: number): boolean {
    this.lastTickAt = Math.max(this.lastTickAt, now);
    if (this._state === "ADDRESSED" || this._state === "RESPONDING") return false;
    if (this._state === "LISTENING") {
      // Someone is talking (or the admit click is still ringing): greet when the room goes quiet.
      this.greetingPending = true;
      this.greetingExpiresAt = this.opts.greetingTtlMs > 0 ? now + this.opts.greetingTtlMs : Infinity;
      return false;
    }
    this.greet(now);
    return true;
  }

  private greet(now: number): void {
    this.greetingPending = false;
    this.greeting = true;
    this.addressedBy = { text: "", detection: { addressed: false, invited: true, confidence: 1, reason: JOINED_REASON } };
    this.transition("ADDRESSED", now, JOINED_REASON);
  }

  /** Should the session forward audio / let the assistant answer now? */
  shouldRespond(now: number): boolean {
    this.tick(now);
    return this._state === "ADDRESSED";
  }

  /** Time-based transitions; call periodically. */
  tick(now: number): void {
    this.lastTickAt = Math.max(this.lastTickAt, now);
    this.expireEngagement(now);
    if (this.heldFollowUp && now - this.heldFollowUp.at >= this.opts.fragmentHoldMs) {
      // No second reading came: the follow-up is answered as heard.
      const h = this.heldFollowUp;
      this.takeTurn(h.seg, h.key, h.detection, now, "engaged follow-up (held)");
      return;
    }
    if (this.greetingPending && now >= this.greetingExpiresAt) {
      // The pause never came; the moment for a hello has passed.
      this.greetingPending = false;
    }
    if (this.greetingPending && this._state === "OBSERVING" && this.yieldingUntil <= now) {
      this.greet(now);
      return;
    }
    if (this._state === "LISTENING" && now - this.lastSpeechAt > this.opts.silenceGapMs) {
      const proactive = this.opts.proactivity === "active" || this.opts.proactivity === "open";
      const inCooldown = now - this.lastResponseEndAt < this.opts.cooldownMs;
      const capped = this.consecutive >= this.opts.maxConsecutiveResponses;
      if (this.pendingQuestion && proactive && !inCooldown && !capped && now - this.pendingQuestion.at >= this.opts.activeSilenceMs) {
        const open = this.opts.proactivity === "open";
        this.addressedBy = {
          text: this.pendingQuestion.text,
          speakerName: this.pendingQuestion.speakerName,
          detection: { addressed: false, invited: true, confidence: 0.5, reason: open ? "joined the conversation (open)" : "unanswered question (active)" },
        };
        // A turn taken uninvited is still a conversation with whoever it answered: their next line
        // is a follow-up, not another wait for silence.
        this.engage(this.pendingQuestion.key, now);
        this.pendingQuestion = null;
        this.transition("ADDRESSED", now, open ? "joined the conversation" : "unanswered question");
        return;
      }
      this.pendingQuestion = null;
      this.transition("OBSERVING", now, "silence");
    }
  }

  /**
   * The AI's own provider has started an answer nobody asked it for.
   *
   * A speech-to-speech provider *is* a turn-taker: it hears the room, decides the person has finished
   * and starts talking, all before this policy's timer has finished waiting for the pause. In a
   * one-to-one — the "open" tier, where ordinary conversation earns a turn anyway — that decision is
   * the same decision this policy would have made, only sooner, so it is adopted rather than cut. The
   * conditions are the ones that make it an answer rather than a monologue: the room said something,
   * it said it since the character last finished, and the character has not already run past the
   * consecutive cap. In every other tier the character still speaks only when it is spoken to.
   */
  acceptSelfTurn(now: number, providerDecides = false): boolean {
    // Native audio models already receive the participation rules in their system prompt.
    // They can hear an address even when their optional transcription misses it.
    if (!providerDecides && this.opts.proactivity !== "open") return false;
    if (this._state === "RESPONDING" || this._state === "ADDRESSED") return false;
    /**
     * What the room said, if the recogniser has delivered it yet — and if it has not, the fact that
     * the room was heard speaking at all. A provider that transcribes and answers in one pass can
     * start the answer before the words arrive, and a turn refused for want of a transcript is an
     * answer nobody hears.
     */
    const heard = this.lastFinal && now - this.lastFinal.at <= this.opts.selfTurnWindowMs && this.lastFinal.at > this.lastResponseEndAt
      ? this.lastFinal
      : this.lastSpeechAt > this.lastResponseEndAt && now - this.lastSpeechAt <= this.opts.selfTurnWindowMs
        ? { text: "", at: this.lastSpeechAt, key: this.engagement?.participantId ?? null, speakerName: null }
        : null;
    if (!heard) return false;
    // Fresh native-audio input starts a new exchange even if no text was produced to reset the cap.
    if (providerDecides) this.consecutive = 0;
    if (this.consecutive >= this.opts.maxConsecutiveResponses) return false;
    this.pendingQuestion = null;
    this.heldFollowUp = null;
    this.addressedBy = { text: heard.text, speakerName: heard.speakerName, detection: { addressed: false, invited: true, confidence: 0.5, reason: SELF_TURN_REASON } };
    this.engage(heard.key, now);
    this.transition("ADDRESSED", now, SELF_TURN_REASON);
    return true;
  }

  /** The assistant has started answering. */
  markResponding(now: number): void {
    if (this._state !== "RESPONDING") this.transition("RESPONDING", now, "assistant speaking");
  }

  /** The assistant finished (or was cut off). */
  onAssistantDone(now: number): void {
    if (this.greeting) this.greeting = false;
    else {
      this.lastResponseEndAt = now;
      this.consecutive++;
    }
    this.interruptedInARow = 0;
    this.addressedBy = null;
    const held = this.heldAddress;
    this.heldAddress = null;
    if (held) {
      // Spoken to while speaking (see `onTranscript`): that line is the next turn, not the silence.
      this.addressedBy = { text: held.seg.text, speakerName: held.seg.speakerName, detection: held.detection };
      this.pendingQuestion = null;
      this.engage(this.speakerKey(held.seg), now);
      this.transition("ADDRESSED", now, `${held.detection.reason} (held while speaking)`);
      return;
    }
    this.transition("OBSERVING", now, "assistant done");
  }

  /** Force back to observing (e.g. operator pressed "mute character"). */
  reset(now: number): void {
    this.yieldingUntil = -Infinity;
    this.greeting = false;
    this.greetingPending = false;
    this.addressedBy = null;
    this.pendingQuestion = null;
    this.heldFollowUp = null;
    this.heldAddress = null;
    this.engagement = null;
    this.transition("OBSERVING", now, "reset");
  }

  private isSelf(name?: string | null): boolean {
    if (!name) return false;
    const n = name.toLowerCase();
    return this.opts.selfNames.some((s) => s && n.includes(s.toLowerCase()));
  }

  private transition(to: ParticipationState, at: number, reason: string): void {
    const from = this._state;
    if (from === to) return;
    // Spoken to before the greeting got its silence: that turn is the introduction, the greeting is moot.
    if (to === "ADDRESSED" && reason !== JOINED_REASON) this.greetingPending = false;
    this._state = to;
    const t = { from, to, at, reason };
    this.history.push(t);
    if (this.history.length > 200) this.history.shift();
    for (const l of this.listeners) l(t);
  }
}
