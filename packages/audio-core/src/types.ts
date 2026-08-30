/**
 * Internal audio format (spec §23):
 *   Float32 PCM / 48 kHz / mono
 * Every provider adapter converts at its boundary; the app never sees provider rates.
 */
export const INTERNAL_SAMPLE_RATE = 48_000;

export interface PCMFrame {
  /** Mono Float32 samples in [-1, 1]. */
  data: Float32Array;
  /** Sample rate of `data`. Internal frames are always INTERNAL_SAMPLE_RATE. */
  sampleRate: number;
  /** Always 1 for internal frames. Multi-channel input is downmixed by the normalizer. */
  channels: 1;
  /** Monotonic timestamp in ms (performance.now()-style) of the first sample. */
  timestamp: number;
}

export interface ImageFrame {
  /** JPEG/PNG bytes or data URL. */
  data: Uint8Array | string;
  mimeType: "image/jpeg" | "image/png";
  width: number;
  height: number;
  timestamp: number;
}

export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createFrame(data: Float32Array, sampleRate = INTERNAL_SAMPLE_RATE, timestamp = now()): PCMFrame {
  return { data, sampleRate, channels: 1, timestamp };
}

export function frameDurationMs(frame: PCMFrame): number {
  return (frame.data.length / frame.sampleRate) * 1000;
}
