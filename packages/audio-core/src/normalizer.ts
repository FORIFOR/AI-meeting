import { INTERNAL_SAMPLE_RATE, createFrame, type PCMFrame } from "./types.js";
import { createResampler, type Resampler } from "./resample.js";
import { downmixToMono, float32ToInt16 } from "./pcm.js";

export type FrameListener = (frame: PCMFrame) => void;

/**
 * AudioNormalizer: everything entering the app becomes Float32 / 48k / mono.
 * `audioNormalizer.push(frame)` accepts any sample rate and channel count.
 */
export class AudioNormalizer {
  private resamplers = new Map<number, Resampler>();
  private listeners = new Set<FrameListener>();

  constructor(readonly targetRate: number = INTERNAL_SAMPLE_RATE) {}

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Push raw audio; channels>1 means interleaved. Returns the normalized frame. */
  push(input: { data: Float32Array; sampleRate: number; channels?: number; timestamp?: number }): PCMFrame {
    const mono = downmixToMono(input.data, input.channels ?? 1);
    let resampler = this.resamplers.get(input.sampleRate);
    if (!resampler) {
      resampler = createResampler(input.sampleRate, this.targetRate);
      this.resamplers.set(input.sampleRate, resampler);
    }
    const data = resampler.process(mono);
    const frame = createFrame(data, this.targetRate, input.timestamp);
    for (const l of this.listeners) l(frame);
    return frame;
  }

  reset(): void {
    for (const r of this.resamplers.values()) r.reset();
  }
}

export interface OutboundConverterOptions {
  /** Provider input rate, e.g. 16000 for Gemini, 24000 for OpenAI PCM16. */
  targetRate: number;
  /** Chunk size in ms; frames are accumulated and emitted in this size. Default 20ms. */
  chunkMs?: number;
}

/**
 * Converts internal 48k frames to a provider's input format (Int16 chunks at target rate).
 * Used at the provider adapter boundary so the app never reasons about provider rates.
 */
export class OutboundAudioConverter {
  private resampler: Resampler;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private readonly chunkSamples: number;

  constructor(private readonly opts: OutboundConverterOptions, sourceRate = INTERNAL_SAMPLE_RATE) {
    this.resampler = createResampler(sourceRate, opts.targetRate);
    this.chunkSamples = Math.round(((opts.chunkMs ?? 20) / 1000) * opts.targetRate);
  }

  /** Push an internal frame; returns zero or more Int16 chunks ready to send. */
  push(frame: PCMFrame): Int16Array[] {
    const data = this.resampler.process(frame.data);
    this.pending.push(data);
    this.pendingLen += data.length;
    const out: Int16Array[] = [];
    while (this.pendingLen >= this.chunkSamples) {
      const chunk = new Float32Array(this.chunkSamples);
      let filled = 0;
      while (filled < this.chunkSamples) {
        const head = this.pending[0]!;
        const take = Math.min(head.length, this.chunkSamples - filled);
        chunk.set(head.subarray(0, take), filled);
        filled += take;
        if (take === head.length) this.pending.shift();
        else this.pending[0] = head.subarray(take);
      }
      this.pendingLen -= this.chunkSamples;
      out.push(float32ToInt16(chunk));
    }
    return out;
  }

  flush(): Int16Array | null {
    if (this.pendingLen === 0) return null;
    const all = new Float32Array(this.pendingLen);
    let off = 0;
    for (const p of this.pending) {
      all.set(p, off);
      off += p.length;
    }
    this.pending = [];
    this.pendingLen = 0;
    return float32ToInt16(all);
  }
}
