import type { PhonemeResult } from "./wlipsyncCore.js";

export type LipSyncWorkerInput =
  | { type: "reset"; generation: number }
  | { type: "audio"; generation: number; sequence: number; at: number; sampleRate: number; data: Float32Array };
export type LipSyncWorkerOutput =
  | { type: "ready" }
  | { type: "failed" }
  | ({ type: "result"; generation: number; sequence: number; at: number } & PhonemeResult);

export interface LipSyncWorker {
  onmessage: ((event: MessageEvent<LipSyncWorkerOutput>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: LipSyncWorkerInput, transfer?: Transferable[]): void;
  terminate(): void;
}
