/**
 * Inline AudioWorklet processor that forwards PCM render quanta to the main thread.
 * Registered from a Blob URL so no separate asset needs to be served.
 *
 * Lifecycle rules (docs/audio-lifecycle.md):
 * - one registration per BaseAudioContext; concurrent callers share the in-flight promise
 * - the Blob URL stays alive until `addModule` has settled (revoking early aborts the load)
 * - a context that is closed while the module loads rejects with `WorkletUnavailableError`
 *   (Chrome reports `AbortError: Unable to load a worklet's module`); callers decide whether that
 *   matters — a disposed session simply ignores it. No rejection is ever left unhandled here.
 */
const PROCESSOR_NAME = "rcai-pcm-tap";

const PROCESSOR_SOURCE = `
class RcaiPcmTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.batch = [];
    this.batchLen = 0;
    this.target = (options && options.processorOptions && options.processorOptions.batchSamples) || 480;
    this.closed = false;
    this.port.onmessage = (e) => { if (e.data === "close") { this.closed = true; this.port.close(); } };
  }
  process(inputs, outputs) {
    if (this.closed) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (input && input[0]) {
      const ch = input[0];
      if (output && output[0]) output[0].set(ch);
      this.batch.push(new Float32Array(ch));
      this.batchLen += ch.length;
      if (this.batchLen >= this.target) {
        const merged = new Float32Array(this.batchLen);
        let off = 0;
        for (const b of this.batch) { merged.set(b, off); off += b.length; }
        this.port.postMessage(merged, [merged.buffer]);
        this.batch = [];
        this.batchLen = 0;
      }
    }
    return true;
  }
}
registerProcessor("${PROCESSOR_NAME}", RcaiPcmTap);
`;

export class WorkletUnavailableError extends Error {
  constructor(readonly reason: "closed" | "aborted" | "unsupported", cause?: unknown) {
    super(`AudioWorklet unavailable (${reason})${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "WorkletUnavailableError";
  }
}

const registered = new WeakSet<BaseAudioContext>();
const inFlight = new WeakMap<BaseAudioContext, Promise<void>>();
let moduleUrl: string | null = null;

function getModuleUrl(): string {
  // One Blob URL for the page lifetime: never revoked while any addModule could still be reading it.
  if (!moduleUrl) moduleUrl = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "application/javascript" }));
  return moduleUrl;
}

function isClosed(ctx: BaseAudioContext): boolean {
  return (ctx.state as string) === "closed";
}

/** A rejected promise that never counts as unhandled (callers may fire-and-forget). */
function handledReject(err: Error): Promise<never> {
  const p = Promise.reject(err);
  p.catch(() => {});
  return p;
}

/** Registers the tap processor once per context. Safe to call concurrently. */
export function ensurePcmTapWorklet(ctx: BaseAudioContext): Promise<void> {
  if (registered.has(ctx)) return Promise.resolve();
  const pending = inFlight.get(ctx);
  if (pending) return pending;
  if (isClosed(ctx)) return handledReject(new WorkletUnavailableError("closed"));
  if (!ctx.audioWorklet) return handledReject(new WorkletUnavailableError("unsupported"));
  const p = ctx.audioWorklet
    .addModule(getModuleUrl())
    .then(() => {
      registered.add(ctx);
    })
    .catch((err: unknown) => {
      // Chrome: AbortError when the context was closed (or the page unloaded) mid-load.
      if (isClosed(ctx)) throw new WorkletUnavailableError("closed", err);
      const name = (err as { name?: string } | null)?.name;
      throw new WorkletUnavailableError(name === "AbortError" ? "aborted" : "unsupported", err);
    })
    .finally(() => {
      inFlight.delete(ctx);
    });
  inFlight.set(ctx, p);
  // Attach a no-op handler so an un-awaited failure never becomes an unhandled rejection;
  // callers still receive the rejection through the returned promise.
  p.catch(() => {});
  return p;
}

export interface PcmTapNode {
  node: AudioWorkletNode;
  onChunk(cb: (chunk: Float32Array) => void): () => void;
  /** Disconnects, closes the message port and stops the processor. Idempotent. */
  dispose(): void;
  readonly disposed: boolean;
}

export async function createPcmTapNode(ctx: BaseAudioContext, batchMs = 10): Promise<PcmTapNode> {
  await ensurePcmTapWorklet(ctx);
  if (isClosed(ctx)) throw new WorkletUnavailableError("closed");
  const batchSamples = Math.max(128, Math.round((batchMs / 1000) * ctx.sampleRate));
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { batchSamples },
  });
  const listeners = new Set<(chunk: Float32Array) => void>();
  let disposed = false;
  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (disposed) return;
    for (const l of listeners) l(ev.data);
  };
  return {
    node,
    get disposed() {
      return disposed;
    },
    onChunk(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      node.port.onmessage = null;
      try {
        node.port.postMessage("close"); // processor returns false → released by the render thread
      } catch {
        /* context already closed */
      }
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    },
  };
}
