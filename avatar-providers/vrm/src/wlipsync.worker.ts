import wasmUrl from "wlipsync/wlipsync.wasm?url";
import { WLipSyncCore } from "./wlipsyncCore.js";
import type { LipSyncWorkerInput, LipSyncWorkerOutput } from "./wlipsyncProtocol.js";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<LipSyncWorkerInput>) => void) | null;
  postMessage(message: LipSyncWorkerOutput): void;
};

async function initialize(): Promise<void> {
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error("WLIPSYNC_WASM_LOAD_FAILED");
  const core = await WLipSyncCore.create(await response.arrayBuffer());
  let generation = -1;
  let previousSequence = -1;
  scope.onmessage = ({ data }) => {
    try {
      if (data.type === "reset") {
        generation = data.generation;
        previousSequence = -1;
        core.reset();
        return;
      }
      if (data.generation !== generation || data.sequence !== previousSequence + 1) core.reset();
      generation = data.generation;
      previousSequence = data.sequence;
      const result = core.analyze(data.data, data.sampleRate);
      scope.postMessage({ type: "result", generation, sequence: data.sequence, at: data.at, ...result });
    } catch {
      scope.postMessage({ type: "failed" });
    }
  };
  scope.postMessage({ type: "ready" });
}

void initialize().catch(() => scope.postMessage({ type: "failed" }));
