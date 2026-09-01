/**
 * Head gestures from a low-rate angle stream.
 *
 * A nod is not "pitch is large"; it is pitch going one way and coming back inside about three quarters
 * of a second. Holding the head down — reading, looking at a keyboard — must not read as agreement,
 * which is exactly what a threshold on the angle alone would do. The same shape on yaw is a head shake.
 *
 * Attendee's webcam stream is 2 fps at 360p, so a gesture is three or four samples. The detector is
 * built for that: it looks for a signed excursion followed by a return, over a window, rather than for
 * a smooth oscillation it will never see.
 */
export interface GestureOptions {
  /** How far the head must move from its resting angle, in radians. Default 0.12 (~7°). */
  amplitude?: number;
  /**
   * How long the whole out-and-back may take, in ms. Default 2000: at 2 fps a nod is three or four
   * samples, and a 1400 ms window drops the resting sample before the return arrives — the excursion
   * is then measured from the bottom of the nod and never exceeds the threshold.
   */
  windowMs?: number;
  /** Never drop below this many samples, whatever the window says. Default 4. */
  minSamples?: number;
  /** How close to the resting angle counts as "came back". Default 0.6 of the amplitude. */
  returnRatio?: number;
  /** Refractory period after a gesture, in ms, so one nod is not counted three times. Default 1200. */
  cooldownMs?: number;
}

interface Sample {
  at: number;
  value: number;
}

/** One axis: feed it angles, ask whether an out-and-back just completed. */
export class GestureDetector {
  private samples: Sample[] = [];
  private lastFiredAt = -Infinity;
  private readonly amplitude: number;
  private readonly windowMs: number;
  private readonly returnRatio: number;
  private readonly cooldownMs: number;
  private readonly minSamples: number;

  constructor(opts: GestureOptions = {}) {
    this.amplitude = opts.amplitude ?? 0.12;
    this.windowMs = opts.windowMs ?? 2000;
    this.minSamples = opts.minSamples ?? 4;
    this.returnRatio = opts.returnRatio ?? 0.6;
    this.cooldownMs = opts.cooldownMs ?? 1200;
  }

  /** @returns true on the sample that completes the gesture. */
  push(value: number, at: number): boolean {
    this.samples.push({ at, value });
    while (this.samples.length > this.minSamples && at - this.samples[0]!.at > this.windowMs) this.samples.shift();
    if (at - this.lastFiredAt < this.cooldownMs) return false;
    if (this.samples.length < 3) return false;

    // Resting angle = where the head was when the window opened; the excursion is measured from there.
    const base = this.samples[0]!.value;
    let peak = 0;
    let peakIndex = -1;
    for (let i = 1; i < this.samples.length; i++) {
      const d = this.samples[i]!.value - base;
      if (Math.abs(d) > Math.abs(peak)) {
        peak = d;
        peakIndex = i;
      }
    }
    if (peakIndex < 0 || Math.abs(peak) < this.amplitude) return false;
    // Did it come back? Only samples after the peak count, or a slow drift would look like a return.
    for (let i = peakIndex + 1; i < this.samples.length; i++) {
      if (Math.abs(this.samples[i]!.value - base) <= Math.abs(peak) * (1 - this.returnRatio)) {
        this.lastFiredAt = at;
        this.samples = [];
        return true;
      }
    }
    return false;
  }

  reset(): void {
    this.samples = [];
    this.lastFiredAt = -Infinity;
  }
}
