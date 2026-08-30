import fs from "node:fs";
import { EnergyVAD, createFrame } from "@rcai/audio-core";
import { loadSherpa } from "./sherpa.js";

export type VADAdapterEvent =
  | { type: "speech_start"; at: number }
  | {
      type: "speech_end";
      at: number;
      samples: Float32Array;
      /** Samples fed after the segment actually ended when the decision fired (intrinsic VAD end lag). */
      endLagSamples?: number;
    };

export interface VADAdapter {
  readonly engine: string;
  /** Feed 16 kHz mono float samples (any chunk size). */
  process(samples: Float32Array, at: number): VADAdapterEvent[];
  readonly speaking: boolean;
  reset(): void;
}

/** Silero VAD through sherpa-onnx (windowSize 512 @ 16k). */
export class SileroVAD implements VADAdapter {
  readonly engine = "silero-vad";
  private vad: InstanceType<NonNullable<ReturnType<typeof loadSherpa>>["Vad"]> | null = null;
  private pending = new Float32Array(0);
  private detected = false;
  private fed = 0;

  constructor(modelPath: string | null, opts: { minSilenceSec?: number; minSpeechSec?: number; threshold?: number } = {}) {
    const sherpa = loadSherpa();
    if (sherpa && modelPath && fs.existsSync(modelPath)) {
      try {
        this.vad = new sherpa.Vad(
          { sileroVad: { model: modelPath, threshold: opts.threshold ?? 0.5, minSilenceDuration: opts.minSilenceSec ?? 0.45, minSpeechDuration: opts.minSpeechSec ?? 0.08, maxSpeechDuration: 30, windowSize: 512 }, sampleRate: 16000, numThreads: 1, debug: 0 },
          60,
        );
      } catch (err) {
        console.warn("[agent] silero VAD init failed:", (err as Error).message);
      }
    }
  }

  get available(): boolean {
    return this.vad !== null;
  }

  get speaking(): boolean {
    return this.detected;
  }

  process(samples: Float32Array, at: number): VADAdapterEvent[] {
    if (!this.vad) return [];
    const merged = new Float32Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    const events: VADAdapterEvent[] = [];
    let off = 0;
    while (off + 512 <= merged.length) {
      this.vad.acceptWaveform(merged.subarray(off, off + 512));
      off += 512;
      this.fed += 512;
      const nowDetected = this.vad.isDetected();
      if (nowDetected && !this.detected) {
        this.detected = true;
        events.push({ type: "speech_start", at });
      }
      while (!this.vad.isEmpty()) {
        const seg = this.vad.front() as { start?: number; samples: Float32Array };
        this.vad.pop();
        this.detected = false;
        const end = typeof seg.start === "number" ? seg.start + seg.samples.length : undefined;
        events.push({ type: "speech_end", at, samples: new Float32Array(seg.samples), endLagSamples: end !== undefined ? Math.max(0, this.fed - end) : undefined });
      }
      if (!nowDetected && this.detected && this.vad.isEmpty()) {
        // detection dropped without a segment (too short) – treat as end with what we have
        this.detected = false;
      }
    }
    this.pending = merged.subarray(off);
    return events;
  }

  reset(): void {
    this.vad?.reset();
    this.pending = new Float32Array(0);
    this.detected = false;
    this.fed = 0;
  }
}

/** Energy VAD fallback (from @rcai/audio-core) that also collects the utterance samples. */
export class EnergyVADAdapter implements VADAdapter {
  readonly engine = "energy-vad";
  private vad = new EnergyVAD({ minSpeechMs: 80, hangoverMs: 500 });
  private preroll: Float32Array[] = [];
  private prerollLen = 0;
  private capture: Float32Array[] | null = null;

  get speaking(): boolean {
    return this.vad.isSpeaking;
  }

  process(samples: Float32Array, at: number): VADAdapterEvent[] {
    const out: VADAdapterEvent[] = [];
    // keep ~300 ms pre-roll so the first phoneme is not clipped
    this.preroll.push(samples);
    this.prerollLen += samples.length;
    while (this.prerollLen > 4800 && this.preroll.length > 1) this.prerollLen -= this.preroll.shift()!.length;
    if (this.capture) this.capture.push(samples);
    for (const ev of this.vad.process(createFrame(samples, 16000, at))) {
      if (ev.type === "speech_start") {
        this.capture = [...this.preroll];
        out.push({ type: "speech_start", at: ev.timestamp });
      } else if (this.capture) {
        const total = this.capture.reduce((a, c) => a + c.length, 0);
        const merged = new Float32Array(total);
        let o = 0;
        for (const c of this.capture) { merged.set(c, o); o += c.length; }
        this.capture = null;
        out.push({ type: "speech_end", at: ev.timestamp, samples: merged, endLagSamples: 8000 /* 500 ms hangover */ });
      }
    }
    return out;
  }

  reset(): void {
    this.vad.reset();
    this.capture = null;
    this.preroll = [];
    this.prerollLen = 0;
  }
}
