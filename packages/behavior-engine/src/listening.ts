import type { Gesture } from "@rcai/avatar-core";

export interface ListeningContext {
  /** ms since LISTENING started */
  elapsedMs: number;
  /** ms since the user's last audible frame (pauses invite nods) */
  sinceUserAudioMs: number;
  /** running level 0..1 of the user's speech energy */
  userEnergy: number;
  /** latest partial transcript */
  transcript: string;
  /** emotion hint from the semantic planner ("warm_positive", "concerned", …) */
  emotion?: string;
  /** Listener Semantics category of what the user is saying right now. */
  category?: "positive" | "serious" | "surprising" | "uncertain" | "emotional_negative" | "neutral";
  /** Nod cadence multiplier from Listener Semantics (1 = default). */
  nodRate?: number;
  lastAction?: ListeningAction["kind"];
}

export type ListeningAction =
  | { kind: "tiny_nod"; gesture: Gesture; intensity: number }
  | { kind: "head_tilt"; gesture: Gesture; intensity: number }
  | { kind: "gaze_shift" }
  | { kind: "posture"; tags: string[] }
  | { kind: "brow"; gesture: Gesture; intensity: number };

/**
 * Spec §13: the most important behaviour. Choose listening reactions from time,
 * user speech amount, content, emotion and the previous action — never blind randomness.
 */
export class ListeningScheduler {
  private lastNodAt = -1e9;
  private lastTiltAt = -1e9;
  private lastPostureAt = -1e9;
  private lastBrowAt = -1e9;
  private nodCount = 0;

  constructor(private readonly rng: () => number) {}

  reset(now: number): void {
    this.lastNodAt = now - 1500;
    this.lastTiltAt = now;
    this.lastPostureAt = now;
    this.lastBrowAt = now;
    this.nodCount = 0;
  }

  /** Called ~every 250 ms while LISTENING. */
  next(now: number, ctx: ListeningContext): ListeningAction | null {
    const sinceNod = now - this.lastNodAt;
    const sinceTilt = now - this.lastTiltAt;
    const sincePosture = now - this.lastPostureAt;
    const text = ctx.transcript;
    const longSpeech = ctx.elapsedMs > 6000;
    const pause = ctx.sinceUserAudioMs > 350 && ctx.sinceUserAudioMs < 1500;

    // Long user speech -> occasional nod, more likely at pauses and after a clause end.
    let nodP = 0;
    const nodRate = ctx.nodRate ?? 1;
    if (sinceNod > 2500 / nodRate) {
      nodP = 0.05 + Math.min(0.25, (sinceNod - 2500) / 20000);
      if (pause) nodP += 0.35;
      if (/[。！？!?]\s*$/.test(text) || /(です|ます|でした|と思います|んです)$/.test(text)) nodP += 0.2;
      if (longSpeech) nodP += 0.1;
      if (ctx.emotion === "concerned" || ctx.emotion === "serious") nodP *= 0.6;
      if (ctx.lastAction === "tiny_nod") nodP *= 0.5;
      nodP *= nodRate;
    }
    if (this.rng() < nodP) {
      this.lastNodAt = now;
      this.nodCount++;
      // vary: mostly small, sometimes normal; never the same strength three times in a row.
      // Serious / painful content: only slow, small acknowledgement nods.
      const grave = ctx.category === "emotional_negative" || ctx.category === "serious";
      const strong = !grave && this.nodCount % 3 === 0 && ctx.userEnergy > 0.5;
      const base = grave ? 0.25 : 0.35;
      return { kind: "tiny_nod", gesture: strong ? "nod_normal" : "nod_small", intensity: strong ? 0.6 : base + this.rng() * 0.2 };
    }

    // Head tilt on questions or when the user is quiet/hesitant for a while.
    if (sinceTilt > 7000) {
      let tiltP = 0.02;
      if (/[？?]\s*$/.test(text) || /(かな|ですか|でしょうか)$/.test(text)) tiltP += 0.4;
      if (ctx.sinceUserAudioMs > 1500) tiltP += 0.15;
      if (ctx.lastAction === "head_tilt") tiltP = 0;
      if (this.rng() < tiltP) {
        this.lastTiltAt = now;
        return { kind: "head_tilt", gesture: "head_tilt", intensity: 0.4 + this.rng() * 0.3 };
      }
    }

    // Eyebrow raise on surprising/positive content.
    if (now - this.lastBrowAt > 5000 && /(すごい|本当|まじ|えっ|wow|really|amazing)/i.test(text.slice(-12))) {
      this.lastBrowAt = now;
      return { kind: "brow", gesture: "eyebrow_raise", intensity: 0.5 };
    }

    // Re-pick listening posture every ~8-14 s so long answers don't loop one clip.
    if (sincePosture > 8000 + this.rng() * 6000) {
      this.lastPostureAt = now;
      const tags = ctx.emotion === "serious" || ctx.emotion === "concerned" ? ["serious"] : longSpeech ? [] : [];
      return { kind: "posture", tags };
    }
    return null;
  }
}
