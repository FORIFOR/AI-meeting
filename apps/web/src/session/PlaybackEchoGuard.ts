import type { PCMFrame } from "@rcai/audio-core";

const HISTORY_MS = 240;
const SEARCH_RATE = 4000;
const STRONG_MATCH = 0.985;

/** Recognize a delayed copy of playback after browser AEC. Mixed or uncertain frames pass intact. */
export class PlaybackEchoGuard {
  private rate = 0;
  private block = 1;
  private reference = new Float32Array(0);
  private fullRate = new Float32Array(0);
  private pending = new Float32Array(0);
  private pendingSize = 0;
  private cursor = 0;
  private count = 0;

  reset(): void {
    this.count = 0;
    this.cursor = 0;
    this.pendingSize = 0;
  }

  playback(frame: PCMFrame): void {
    if (frame.sampleRate !== this.rate) {
      this.reset();
      this.rate = frame.sampleRate;
      this.block = Math.max(1, Math.round(this.rate / SEARCH_RATE));
      this.reference = new Float32Array(Math.ceil(this.rate * HISTORY_MS / (1000 * this.block)));
      this.fullRate = new Float32Array(this.reference.length * this.block);
      this.pending = new Float32Array(this.block);
    }
    if (!this.rate) return;
    for (const sample of frame.data) {
      this.pending[this.pendingSize++] = sample;
      if (this.pendingSize < this.block) continue;
      this.reference[this.cursor] = this.mean(this.pending, 0);
      this.fullRate.set(this.pending, this.cursor * this.block);
      this.cursor = (this.cursor + 1) % this.reference.length;
      this.count = Math.min(this.count + 1, this.reference.length);
      this.pendingSize = 0;
    }
  }

  filter(frame: PCMFrame): PCMFrame {
    const size = Math.floor(frame.data.length / this.block);
    if (frame.sampleRate !== this.rate || size * this.block < frame.sampleRate * 0.006 || size > this.count) return frame;
    const capture = new Float32Array(size);
    let captureEnergy = 0;
    for (let i = 0; i < size; i++) {
      capture[i] = this.mean(frame.data, i * this.block);
      captureEnergy += capture[i]! ** 2;
    }
    if (captureEnergy < size * 0.00001) return frame;
    let bestScore = STRONG_MATCH ** 2;
    let bestDelay: number | undefined;
    for (let delay = 0; delay <= this.count - size; delay++) {
      let dot = 0;
      let referenceEnergy = 0;
      let index = (this.cursor + this.reference.length - size - delay) % this.reference.length;
      for (let i = 0; i < size; i++) {
        const sample = this.reference[index]!;
        dot += capture[i]! * sample;
        referenceEnergy += sample * sample;
        if (++index === this.reference.length) index = 0;
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
    const residual = this.cancelAlignedEcho(frame.data, size * this.block, bestDelay * this.block);
    return residual ? { ...frame, data: residual } : frame;
  }

  private cancelAlignedEcho(capture: Float32Array, size: number, coarseDelay: number): Float32Array | undefined {
    const ringSize = this.fullRate.length;
    const newest = this.cursor * this.block;
    let energy = 0;
    for (let i = 0; i < size; i++) energy += capture[i]! ** 2;
    let best: { score: number; gain: number; start: number } | undefined;
    for (let delay = Math.max(0, coarseDelay - this.block + 1);
         delay + size <= this.count * this.block && delay < coarseDelay + this.block; delay++) {
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
    for (let j = 0; j < this.block; j++) sum += samples[start + j]!;
    return sum / this.block;
  }
}
