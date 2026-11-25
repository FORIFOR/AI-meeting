import type { PCMFrame } from "@rcai/audio-core";

const BLOCK = 12; // 48 kHz to 4 kHz, with box averaging before downsampling.
const HISTORY = 960; // Retain 240 ms of rendered audio in memory only.
const STRONG_MATCH = 0.985;

/** Recognize a delayed copy of playback after browser AEC. Mixed or uncertain frames pass intact. */
export class PlaybackEchoGuard {
  private readonly reference = new Float32Array(HISTORY);
  private cursor = 0;
  private count = 0;

  reset(): void {
    this.count = 0;
    this.cursor = 0;
  }

  playback(frame: PCMFrame): void {
    if (frame.sampleRate !== 48000) {
      this.reset();
      return;
    }
    for (let i = 0; i + BLOCK <= frame.data.length; i += BLOCK) {
      this.reference[this.cursor] = this.mean(frame.data, i);
      this.cursor = (this.cursor + 1) % HISTORY;
      this.count = Math.min(this.count + 1, HISTORY);
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
      if (dot > 0 && dot < referenceEnergy &&
          dot * dot >= STRONG_MATCH ** 2 * captureEnergy * referenceEnergy) {
        return { ...frame, data: new Float32Array(frame.data.length) };
      }
    }
    return frame;
  }

  private mean(samples: Float32Array, start: number): number {
    let sum = 0;
    for (let j = 0; j < BLOCK; j++) sum += samples[start + j]!;
    return sum / BLOCK;
  }
}
