import { AudioNormalizer } from "./normalizer.js";
import { createPcmTapNode, type PcmTapNode } from "./worklet.js";
import { INTERNAL_SAMPLE_RATE, type PCMFrame } from "./types.js";

export interface MicCaptureOptions {
  /** Shared context (owned by the caller — not closed by `stop()`). */
  context?: AudioContext;
  deviceId?: string;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  /** Frame size in ms delivered to listeners (default 20). */
  frameMs?: number;
}

/**
 * Microphone capture that emits internal 48k mono Float32 frames.
 * Also exposes the raw MediaStream for WebRTC providers (OpenAI Realtime).
 *
 * Ownership (docs/audio-lifecycle.md): owns the MediaStream tracks and the tap node;
 * owns the AudioContext only when it created it. `stop()` is idempotent and safe to call
 * while `start()` is still in flight (the in-flight start then releases what it created).
 */
export class MicCapture {
  readonly normalizer = new AudioNormalizer(INTERNAL_SAMPLE_RATE);
  readonly context: AudioContext;
  private readonly ownsContext: boolean;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: PcmTapNode | null = null;
  private muted = false;
  private stopped = false;
  private starting: Promise<MediaStream> | null = null;

  constructor(private readonly opts: MicCaptureOptions = {}) {
    this.ownsContext = !opts.context;
    this.context = opts.context ?? new AudioContext({ sampleRate: INTERNAL_SAMPLE_RATE, latencyHint: "interactive" });
  }

  get mediaStream(): MediaStream | null {
    return this.stream;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  onFrame(cb: (frame: PCMFrame) => void): () => void {
    return this.normalizer.onFrame(cb);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
  }

  get isMuted(): boolean {
    return this.muted;
  }

  start(): Promise<MediaStream> {
    if (this.stream) return Promise.resolve(this.stream);
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async doStart(): Promise<MediaStream> {
    if (this.stopped) throw new Error("MicCapture stopped");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.opts.deviceId ? { exact: this.opts.deviceId } : undefined,
        echoCancellation: this.opts.echoCancellation ?? true,
        noiseSuppression: this.opts.noiseSuppression ?? true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("MicCapture stopped");
    }
    this.stream = stream;
    if (this.context.state !== "running") await this.context.resume().catch(() => {});
    if (this.stopped) throw new Error("MicCapture stopped");
    this.source = this.context.createMediaStreamSource(stream);
    const tap = await createPcmTapNode(this.context, this.opts.frameMs ?? 20);
    if (this.stopped) {
      tap.dispose();
      throw new Error("MicCapture stopped");
    }
    this.tap = tap;
    this.source.connect(tap.node);
    // Do not connect to destination (would echo the mic).
    tap.onChunk((chunk) => {
      if (this.muted || this.stopped) return;
      this.normalizer.push({ data: chunk, sampleRate: this.context.sampleRate, channels: 1 });
    });
    return stream;
  }

  /** Teardown order: tracks → nodes → (owned) context. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.tap?.dispose();
    this.tap = null;
    try {
      this.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.source = null;
    if (this.ownsContext && (this.context.state as string) !== "closed") {
      await this.context.close().catch(() => {});
    }
  }
}
