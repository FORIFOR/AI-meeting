import type { AvatarParams, AvatarState } from "@rcai/avatar-core";
import { gammaLike } from "./rng.js";

/**
 * Blink scheduler (spec §13, Gate B "瞬きが機械的でない").
 * Intervals follow a gamma-like distribution; occasional double blinks; more frequent
 * when THINKING; suppressed briefly after a gaze shift; a blink often accompanies a state change.
 */
export class BlinkController {
  private nextAt: number;
  private suppressUntil = 0;

  constructor(private readonly rng: () => number, now: number, private meanIntervalMs = 4200) {
    this.nextAt = now + gammaLike(rng, meanIntervalMs);
  }

  /** Returns the blink duration to trigger now, or null. */
  update(now: number, state: AvatarState): number | null {
    if (now < this.suppressUntil) return null;
    if (now < this.nextAt) return null;
    const mean = state === "THINKING" ? this.meanIntervalMs * 0.6 : state === "SPEAKING" ? this.meanIntervalMs * 1.15 : this.meanIntervalMs;
    const double = this.rng() < 0.14;
    this.nextAt = now + (double ? 260 : Math.max(900, gammaLike(this.rng, mean)));
    return 120 + this.rng() * 80;
  }

  /** Blink soon (used on state changes / gaze shifts) unless one just happened. */
  nudge(now: number, withinMs = 400): void {
    this.nextAt = Math.min(this.nextAt, now + this.rng() * withinMs);
  }

  suppress(now: number, ms: number): void {
    this.suppressUntil = now + ms;
  }
}

/** Breathing + body sway as additive micro motion (Layer 1/2). */
export class BreathingController {
  private phase = 0;
  private swayPhase = 0;
  private rateHz = 0.24;

  constructor(private readonly rng: () => number) {}

  update(dtMs: number, state: AvatarState): Partial<AvatarParams> {
    const targetRate = state === "SPEAKING" ? 0.32 : state === "THINKING" ? 0.2 : 0.24;
    this.rateHz += (targetRate - this.rateHz) * 0.02;
    this.phase += 2 * Math.PI * this.rateHz * (dtMs / 1000);
    this.swayPhase += 2 * Math.PI * 0.07 * (dtMs / 1000) * (0.9 + 0.2 * this.rng());
    const breath = 0.5 + 0.5 * Math.sin(this.phase);
    return {
      breath: breath * 0.35, // idle clips already carry breath; this adds variance
      bodyAngleX: 0.6 * Math.sin(this.swayPhase),
      bodyAngleZ: 0.3 * Math.sin(this.swayPhase * 0.7 + 1),
      shoulder: 0.05 * Math.sin(this.phase),
    };
  }
}

/** Gaze micro-behaviour: mostly the user, occasional saccades, thinking looks away. */
export class GazeController {
  private nextShiftAt: number;
  private returnAt = 0;

  constructor(private readonly rng: () => number, now: number) {
    this.nextShiftAt = now + 2000 + this.rng() * 4000;
  }

  /** Returns a gaze target when a change should happen. */
  update(now: number, state: AvatarState): { kind: "user" | "away" | "up" | "down"; x?: number; y?: number } | null {
    if (this.returnAt && now >= this.returnAt) {
      this.returnAt = 0;
      this.nextShiftAt = now + 2500 + this.rng() * 5000;
      return { kind: "user" };
    }
    if (now < this.nextShiftAt || this.returnAt) return null;
    if (state === "THINKING") {
      this.returnAt = now + 900 + this.rng() * 1500;
      return { kind: "up", x: (this.rng() - 0.5) * 0.8, y: 0.3 + this.rng() * 0.3 };
    }
    if (state === "SPEAKING" && this.rng() < 0.5) {
      this.returnAt = now + 400 + this.rng() * 600;
      return { kind: "away", x: (this.rng() - 0.5) * 0.7, y: (this.rng() - 0.5) * 0.3 };
    }
    // Listening / idle: tiny saccade, brief.
    this.returnAt = now + 300 + this.rng() * 500;
    return { kind: "away", x: (this.rng() - 0.5) * 0.5, y: (this.rng() - 0.5) * 0.25 };
  }
}
