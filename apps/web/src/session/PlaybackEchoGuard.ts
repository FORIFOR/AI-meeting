import type { PCMFrame } from "@rcai/audio-core";

const BLOCK = 12; // 48 kHz to 4 kHz, with box averaging before downsampling.
const HISTORY = 960; // Retain 240 ms of rendered audio in memory only.
const STRONG_MATCH = 0.985;

/** Recognize a delayed copy of playback after browser AEC. Mixed or uncertain frames pass intact. */
export class PlaybackEchoGuard {
  private readonly reference = new Float32Array(HISTORY);
  private readonly fullRate = new Float32Array(HISTORY * BLOCK);
  private readonly pending = new Float32Array(BLOCK);
  private pendingSize = 0;
  private cursor = 0;
  private count = 0;

  reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.pendingSize = 0;
  }

  playback(frame: PCMFrame): void {
    if (frame.sampleRate !== 48000) {
      this.reset();
      return;
    }
    for (const sample of frame.data) {
      this.pending[this.pendingSize++] = sample;
      if (this.pendingSize < BLOCK) continue;
      this.reference[this.cursor] = this.mean(this.pending, 0);
      this.fullRate.set(this.pending, this.cursor * BLOCK);
      this.cursor = (this.cursor + 1) % HISTORY;
      this.count = Math.min(this.count + 1, HISTORY);
      this.pendingSize = 0;
    }
  }

  filter(frame: PCMFrame): PCMFrame {
    const size = Math.floor(frame.data.length / BLOCK);
    if (frame.sampleRate !== 48000 || size < 24 || size > this.count) return frame;
    const capture = new Float32Array(size);
    let captureEnergy = 0;
    for (let i = 0; i < size; i++) {
      capture[i] = this.mean(frame.data, i * BLOCK);
      captureEnergy += capture[i]! ** 2;
    }
    if (captureEnergy < size * 0.00001) return frame;
    let bestScore = STRONG_MATCH ** 2;
    let bestDelay: number | undefined;
    for (let delay = 0; delay <= this.count - size; delay++) {
      let dot = 0;
      let referenceEnergy = 0;
      let index = (this.cursor + HISTORY - size - delay) % HISTORY;
      for (let i = 0; i < size; i++) {
        const sample = this.reference[index]!;
        dot += capture[i]! * sample;
        referenceEnergy += sample * sample;
        if (++index === HISTORY) index = 0;
      }
      // The captured copy must be quieter than its reference. Preserve double-talk
      // and all uncertain audio, including the first phoneme, without lookahead.
      if (dot <= 0 || dot >= referenceEnergy) continue;
      const score = dot * dot / (captureEnergy * referenceEnergy);
      if (score >= bestScore) {
        bestScore = score;
        bestDelay = delay;
      }
    }
    if (bestDelay === undefined) return frame;
    const residual = this.cancelAlignedEcho(frame.data, size * BLOCK, bestDelay * BLOCK);
    return residual ? { ...frame, data: residual } : frame;
  }

  private cancelAlignedEcho(capture: Float32Array, size: number, coarseDelay: number): Float32Array | undefined {
    const ringSize = this.fullRate.length;
    const newest = this.cursor * BLOCK;
    let energy = 0;
    for (let i = 0; i < size; i++) energy += capture[i]! ** 2;
    let best: { score: number; gain: number; start: number } | undefined;
    for (let delay = Math.max(0, coarseDelay - BLOCK + 1);
         delay + size <= this.count * BLOCK && delay < coarseDelay + BLOCK; delay++) {
      const start = (newest + ringSize - size - delay) % ringSize;
      let dot = 0;
      let refEnergy = 0;
      let index = start;
      for (let i = 0; i < size; i++) {
        const sample = this.fullRate[index]!;
        dot += capture[i]! * sample;
        refEnergy += sample * sample;
        if (++index === ringSize) index = 0;
      }
      if (dot <= 0 || dot >= refEnergy) continue;
      const score = dot * dot / (energy * refEnergy);
      if (score >= STRONG_MATCH ** 2 && (!best || score > best.score)) {
        best = { score, gain: dot / refEnergy, start };
      }
    }
    if (!best) return undefined;
    const residual = capture.slice();
    let index = best.start;
    for (let i = 0; i < size; i++) {
      residual[i] = residual[i]! - best.gain * this.fullRate[index]!;
      if (++index === ringSize) index = 0;
    }
    return residual;
  }

  private mean(samples: Float32Array, start: number): number {
    let sum = 0;
    for (let j = 0; j < BLOCK; j++) sum += samples[start + j]!;
    return sum / BLOCK;
  }
}
