import { dbfs, rms } from "./pcm.js";
import { frameDurationMs, type PCMFrame } from "./types.js";

export type VADEvent =
  | { type: "speech_start"; timestamp: number }
  | { type: "speech_end"; timestamp: number; durationMs: number };

export interface EnergyVADOptions {
  /** Speech threshold above adaptive noise floor in dB. Default 12. */
  thresholdDb?: number;
  /** Absolute floor in dBFS below which nothing counts as speech. Default -55. */
  absoluteFloorDb?: number;
  /** Minimum continuous speech before speech_start fires (ms). Default 60. */
  minSpeechMs?: number;
  /** Silence hangover before speech_end fires (ms). Default 500. */
  hangoverMs?: number;
  /** Noise floor adaptation rate (0..1 per frame). Default 0.02. */
  adaptRate?: number;
}

/**
 * Lightweight energy VAD with an adaptive noise floor.
 * It is intentionally simple: the fast path for "user started talking → avatar listens"
 * must fire within 100 ms (spec §27) without waiting for a cloud provider's VAD.
 */
export class EnergyVAD {
  private noiseFloorDb = -60;
  private speaking = false;
  private speechAccumMs = 0;
  private silenceAccumMs = 0;
  private speechStartTs = 0;
  private readonly opts: Required<EnergyVADOptions>;

  constructor(opts: EnergyVADOptions = {}) {
    this.opts = {
      thresholdDb: opts.thresholdDb ?? 12,
      absoluteFloorDb: opts.absoluteFloorDb ?? -55,
      minSpeechMs: opts.minSpeechMs ?? 60,
      hangoverMs: opts.hangoverMs ?? 500,
      adaptRate: opts.adaptRate ?? 0.02,
    };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Current level of the last processed frame in dBFS. */
  lastLevelDb = -180;

  process(frame: PCMFrame): VADEvent[] {
    const events: VADEvent[] = [];
    const level = dbfs(rms(frame.data));
    this.lastLevelDb = level;
    const dur = frameDurationMs(frame);
    const isLoud = level > this.opts.absoluteFloorDb && level > this.noiseFloorDb + this.opts.thresholdDb;

    {
      // Adapt the floor: down fast, up slowly on quiet frames; very slowly upward even while loud so
      // steady background noise (fans, traffic) is learned instead of becoming permanent "speech".
      const target = Math.max(level, -90);
      if (!isLoud) {
        const rate = target < this.noiseFloorDb ? this.opts.adaptRate * 4 : this.opts.adaptRate;
        this.noiseFloorDb += (target - this.noiseFloorDb) * rate;
      } else {
        const longSpeech = this.speaking && frame.timestamp - this.speechStartTs > 8000;
        const rate = this.speaking && !longSpeech ? this.opts.adaptRate * 0.05 : this.opts.adaptRate * 0.25;
        this.noiseFloorDb += (target - this.noiseFloorDb) * rate;
      }
    }

    if (isLoud) {
      this.silenceAccumMs = 0;
      this.speechAccumMs += dur;
      if (!this.speaking && this.speechAccumMs >= this.opts.minSpeechMs) {
        this.speaking = true;
        this.speechStartTs = frame.timestamp - this.speechAccumMs + dur;
        events.push({ type: "speech_start", timestamp: this.speechStartTs });
      }
    } else {
      this.speechAccumMs = 0;
      if (this.speaking) {
        this.silenceAccumMs += dur;
        if (this.silenceAccumMs >= this.opts.hangoverMs) {
          this.speaking = false;
          const end = frame.timestamp + dur - this.silenceAccumMs;
          events.push({ type: "speech_end", timestamp: end, durationMs: end - this.speechStartTs });
          this.silenceAccumMs = 0;
        }
      }
    }
    return events;
  }

  reset(): void {
    this.speaking = false;
    this.speechAccumMs = 0;
    this.silenceAccumMs = 0;
  }
}
