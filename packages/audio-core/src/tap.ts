import type { PCMFrame } from "./types.js";

export type TapListener = (frame: PCMFrame) => void;

/**
 * AudioTap fans the *actually played* PCM out to consumers (speaker + lip sync).
 * Spec §14: lip sync analyses real audio, never TTS text.
 */
export class AudioTap {
  private listeners = new Set<TapListener>();

  subscribe(listener: TapListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(frame: PCMFrame): void {
    for (const l of this.listeners) l(frame);
  }

  get size(): number {
    return this.listeners.size;
  }
}
