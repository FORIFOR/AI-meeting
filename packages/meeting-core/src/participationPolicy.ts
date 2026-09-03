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
  detector?: AddressDetector;
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

/** Acknowledgements, in the languages a room mix gets transcribed into — none of them is a turn. */
const BACKCHANNELS = new Set([
  "うん", "ううん", "はい", "ええ", "へえ", "そう", "そうそう", "そうね", "そうだね", "なるほど", "ふーん", "ふうん", "おっけー", "おけ", "いいね", "いいよ", "了解", "りょうかい", "あー", "えー", "んー",
  "ok", "okay", "yes", "yeah", "yep", "no", "nope", "right", "sure", "great", "good", "nice", "cool", "fine", "hmm", "hm", "mm", "mhm", "uh", "um", "oh", "ah", "wow", "thanks", "thank you",
  "嗯", "好", "好的", "对", "是", "你", "你好", "谢谢",
]);

/**
 * A follow-up is a sentence, not a noise. The recogniser writes a single word — in whatever
 * language the sound resembled most — for a cough or a chair over an open mic, and an engaged
 * character answered 「你。」「Great.」「Okay.」 in a room where nobody had spoken (Gate #8 run 14).
 * Punctuation is stripped; what remains must be at least three characters long and not an
 * acknowledgement. A real 「なんで？」 or "Why?" clears both bars.
 */
export function isFollowUpWorthy(text: string): boolean {
  const core = text.normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  if (core.length < 3 && !/[?？]/.test(text)) return false;
  return !BACKCHANNELS.has(core);
}

export class ParticipationPolicy {
  private _state: ParticipationState = "OBSERVING";
  /** The current turn is the greeting on arrival: not a response, so it spends neither cooldown nor cap. */
  private greeting = false;
  /** Arrived while someone was speaking: the greeting waits for the next silence (`tick`). */
  private greetingPending = false;
  private readonly detector: AddressDetector;
  private readonly opts: Required<Omit<ParticipationPolicyOptions, "detector" | "selfNames" | "soundalikes">> & { selfNames: string[] };
  private lastSpeechAt = -1e9;
  private lastResponseEndAt = -1e9;
  private consecutive = 0;
  private pendingQuestion: { text: string; at: number } | null = null;
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
      visualTurns: options.visualTurns ?? true,
      yieldGraceMs: options.yieldGraceMs ?? 700,
      selfNames: options.selfNames ?? options.names,
      engagementTtlMs: options.engagementTtlMs ?? 90_000,
      maxInterruptedInARow: options.maxInterruptedInARow ?? 3,
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
    // Being cut off does not count as a turn the character took: it did not get to finish one.
    this.consecutive = 0;
    // Cut off this many times in a row, the character was never being listened to: it stops taking
    // follow-ups and waits to be called by name.
    this.interruptedInARow++;
    const talkedOver = this.opts.maxInterruptedInARow > 0 && this.interruptedInARow >= this.opts.maxInterruptedInARow && !!this.engagement;
    if (talkedOver) this.engagement = null;
    if (this._state !== "OBSERVING") this.transition("OBSERVING", now, talkedOver ? "interrupted, talked over" : "interrupted");
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
      return d;
    }
    if (!seg.final) return null;
    const d = this.detector.detect(seg.text);
    const inCooldown = now - this.lastResponseEndAt < this.opts.cooldownMs;
    const capped = this.consecutive >= this.opts.maxConsecutiveResponses;
    if (!d.addressed) {
      // Another participant was addressed / normal chatter → the character is not "on".
      this.consecutive = 0;
    }
    this.expireEngagement(now);
    const key = this.speakerKey(seg);
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
      if (d.addressed) this.interruptedInARow = 0;
      this.addressedBy = { text: seg.text, speakerName: seg.speakerName, detection: d };
      this.pendingQuestion = null;
      this.engage(key, now);
      if (this._state !== "ADDRESSED") this.transition("ADDRESSED", now, engagedFollowUp && !d.addressed ? "engaged follow-up" : explicitly ? d.reason : "invited");
      return d;
    }
    if (this.opts.proactivity === "active" && !explicitly && !inCooldown && !capped && /[？?]\s*$|ですか|ますか|でしょうか/.test(seg.text)) {
      this.pendingQuestion = { text: seg.text, at: now };
    }
    /**
     * "open": ordinary conversation earns a turn too. Held as a pending turn rather than taken here,
     * so the character still waits for the room to go quiet instead of answering into someone's
     * sentence — the difference between joining a conversation and interrupting one.
     */
    if (this.opts.proactivity === "open" && !explicitly && !inCooldown && !capped && seg.text.trim().length >= this.opts.openMinChars) {
      this.pendingQuestion = { text: seg.text, at: now };
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
          detection: { addressed: false, invited: true, confidence: 0.5, reason: open ? "joined the conversation (open)" : "unanswered question (active)" },
        };
        this.pendingQuestion = null;
        this.transition("ADDRESSED", now, open ? "joined the conversation" : "unanswered question");
        return;
      }
      this.pendingQuestion = null;
      this.transition("OBSERVING", now, "silence");
    }
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
    this.transition("OBSERVING", now, "assistant done");
  }

  /** Force back to observing (e.g. operator pressed "mute character"). */
  reset(now: number): void {
    this.yieldingUntil = -Infinity;
    this.greeting = false;
    this.greetingPending = false;
    this.addressedBy = null;
    this.pendingQuestion = null;
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
