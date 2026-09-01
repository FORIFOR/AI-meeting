import { AddressDetector, type AddressDetection } from "./addressDetector.js";

/**
 * ParticipationPolicy: the character never barges into a meeting.
 *   OBSERVING → LISTENING (someone is speaking) → ADDRESSED (directly asked / invited) → RESPONDING → OBSERVING.
 * Pure state machine; the session controller decides how to gate audio to the AI provider from `state`.
 */
export type ParticipationState = "OBSERVING" | "LISTENING" | "ADDRESSED" | "RESPONDING";

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
  proactivity?: Proactivity;
  /** After a response, ignore new triggers for this long (ms). Default 4000. */
  cooldownMs?: number;
  /** Max responses in a row without another participant addressing someone else. Default 2. */
  maxConsecutiveResponses?: number;
  /** LISTENING falls back to OBSERVING after this much silence (ms). Default 2500. */
  silenceGapMs?: number;
  /** In "active" mode, respond to any question once the room has been silent this long (ms). Default 1800. */
  activeSilenceMs?: number;
  /**
   * In "open" mode, an utterance shorter than this many characters is treated as a backchannel
   * (「うん」「はい」「Yeah.」) and does not earn a turn. Default 6.
   */
  openMinChars?: number;
  detector?: AddressDetector;
  /** Names that identify the character itself (its own transcript is ignored). */
  selfNames?: string[];
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

export class ParticipationPolicy {
  private _state: ParticipationState = "OBSERVING";
  private readonly detector: AddressDetector;
  private readonly opts: Required<Omit<ParticipationPolicyOptions, "detector" | "selfNames">> & { selfNames: string[] };
  private lastSpeechAt = -1e9;
  private lastResponseEndAt = -1e9;
  private consecutive = 0;
  private pendingQuestion: { text: string; at: number } | null = null;
  private history: PolicyTransition[] = [];
  private listeners = new Set<(t: PolicyTransition) => void>();
  /** The utterance that triggered ADDRESSED (for the assistant's context). */
  addressedBy: { text: string; speakerName?: string | null; detection: AddressDetection } | null = null;

  constructor(options: ParticipationPolicyOptions) {
    this.opts = {
      names: options.names,
      proactivity: options.proactivity ?? "addressed_only",
      cooldownMs: options.cooldownMs ?? 4000,
      maxConsecutiveResponses: options.maxConsecutiveResponses ?? 2,
      silenceGapMs: options.silenceGapMs ?? 2500,
      activeSilenceMs: options.activeSilenceMs ?? 1800,
      openMinChars: options.openMinChars ?? 6,
      selfNames: options.selfNames ?? options.names,
    };
    this.detector = options.detector ?? new AddressDetector({ names: options.names });
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
    if (active) {
      this.lastSpeechAt = now;
      if (this._state === "OBSERVING") this.transition("LISTENING", now, "speech");
    }
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
    const explicitly = d.addressed;
    const invited = d.invited && (this.opts.proactivity === "invited" || this.opts.proactivity === "active");
    if ((explicitly || invited) && !inCooldown && !capped) {
      this.addressedBy = { text: seg.text, speakerName: seg.speakerName, detection: d };
      this.pendingQuestion = null;
      if (this._state !== "ADDRESSED") this.transition("ADDRESSED", now, explicitly ? d.reason : "invited");
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

  /** Should the session forward audio / let the assistant answer now? */
  shouldRespond(now: number): boolean {
    this.tick(now);
    return this._state === "ADDRESSED";
  }

  /** Time-based transitions; call periodically. */
  tick(now: number): void {
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
    this.lastResponseEndAt = now;
    this.consecutive++;
    this.addressedBy = null;
    this.transition("OBSERVING", now, "assistant done");
  }

  /** Force back to observing (e.g. operator pressed "mute character"). */
  reset(now: number): void {
    this.addressedBy = null;
    this.pendingQuestion = null;
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
    this._state = to;
    const t = { from, to, at, reason };
    this.history.push(t);
    if (this.history.length > 200) this.history.shift();
    for (const l of this.listeners) l(t);
  }
}
