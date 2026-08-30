import { createRequire } from "node:module";

/** Lazy CJS loader for sherpa-onnx-node (native addon). Returns null when unavailable. */
export interface SherpaModule {
  OfflineRecognizer: new (config: Record<string, unknown>) => {
    createStream(): { acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void };
    decode(s: unknown): void;
    getResult(s: unknown): { text: string };
  };
  Vad: new (config: Record<string, unknown>, bufferSeconds: number) => {
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    front(): { start: number; samples: Float32Array };
    flush(): void;
    reset(): void;
    clear(): void;
  };
  readWave(path: string): { samples: Float32Array; sampleRate: number };
}

let cached: SherpaModule | null | undefined;

export function loadSherpa(): SherpaModule | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require("sherpa-onnx-node") as SherpaModule;
  } catch (err) {
    console.warn("[agent] sherpa-onnx-node unavailable:", (err as Error).message);
    cached = null;
  }
  return cached;
}
