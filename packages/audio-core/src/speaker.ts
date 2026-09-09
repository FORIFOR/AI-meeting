import { AudioTap } from "./tap.js";
import { createPcmTapNode, type PcmTapNode } from "./worklet.js";
import { INTERNAL_SAMPLE_RATE, createFrame, type PCMFrame } from "./types.js";
import { createResampler } from "./resample.js";

/**
 * Sink that plays assistant audio. Providers deliver either PCM frames (Gemini/Local)
 * or a MediaStream (OpenAI WebRTC). Both paths go through one output tap so
 * lip sync always analyses the audio that actually reaches the speaker (§14, §23).
 */
export interface AudioSink {
  /**
   * Queue a frame. `opts.generationId` tags it with the assistant generation that produced it;
   * frames older than the generation passed to the last `interrupt()` are ignored (returns false).
   */
  play(frame: PCMFrame, opts?: { generationId?: number }): void | boolean;
  attachStream?(stream: MediaStream): void;
  detachStream?(): void;
  /** Re-enable a stream that `interrupt()` muted (called by the runtime on the next assistant_speech_started). */
  resumeStream?(): void;
  /**
   * Stop everything immediately (target < 100 ms). Returns ms taken.
   * `minGeneration`: frames with generationId below it are refused from now on (generation epoch).
   */
  interrupt(minGeneration?: number): number;
  /** Alias of `interrupt()` for readers who only care about the queue semantics. */
  clearQueue?(minGeneration?: number): number;
  readonly tap: AudioTap;
  /** True while queued/streamed audio is audible. */
  readonly isPlaying: boolean;
}

export interface SpeakerOutputOptions {
  context?: AudioContext;
  /** Scheduling lead time in seconds for PCM playback (default 0.03). */
  leadSeconds?: number;
  /** Tap batch size in ms (default 10). */
  tapBatchMs?: number;
}

export class SpeakerOutput implements AudioSink {
  readonly tap = new AudioTap();
  readonly context: AudioContext;
  private gain: GainNode;
  private tapNode: PcmTapNode | null = null;
  private ready: Promise<void>;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private streamSource: MediaStreamAudioSourceNode | null = null;
  private streamGain: GainNode | null = null;
  private resampler = createResampler(INTERNAL_SAMPLE_RATE, INTERNAL_SAMPLE_RATE);
  private lastTapLevel = 0;
  private streamActive = false;
  private readonly leadSeconds: number;
  /** Generation epoch: frames tagged with a generationId below this are ignored. */
  private killedBelow = 0;
  /** Observability: frames refused because they belonged to a cancelled generation. */
  staleFramesDropped = 0;
  private readonly ownsContext: boolean;
  private closed = false;

  constructor(opts: SpeakerOutputOptions = {}) {
    this.ownsContext = !opts.context;
    this.context = opts.context ?? new AudioContext({ sampleRate: INTERNAL_SAMPLE_RATE, latencyHint: "interactive" });
    this.leadSeconds = opts.leadSeconds ?? 0.03;
    this.gain = this.context.createGain();
    this.gain.connect(this.context.destination);
    if (this.context.sampleRate !== INTERNAL_SAMPLE_RATE) {
      this.resampler = createResampler(INTERNAL_SAMPLE_RATE, this.context.sampleRate);
    }
    this.ready = createPcmTapNode(this.context, opts.tapBatchMs ?? 10)
      .then((tap) => {
        if (this.closed) {
          // close() raced the worklet load (e.g. React StrictMode double-mount): release immediately.
          tap.dispose();
          return;
        }
        this.tapNode = tap;
        // gain -> tap -> destination ; tap also forwards PCM to listeners.
        this.gain.disconnect();
        this.gain.connect(tap.node);
        tap.node.connect(this.context.destination);
        tap.onChunk((chunk) => {
          let peak = 0;
          for (let i = 0; i < chunk.length; i += 8) peak = Math.max(peak, Math.abs(chunk[i] ?? 0));
          this.lastTapLevel = peak;
          this.tap.push(createFrame(chunk, this.context.sampleRate));
        });
      })
      .catch((err: unknown) => {
        // A closed sink has nothing to report; a live one surfaces the failure through whenReady().
        if (this.closed) return;
        throw err;
      });
    // Never an unhandled rejection: callers that care await whenReady().
    this.ready.catch(() => {});
  }

  /** Resolves when the output tap is wired; rejects if the worklet could not load on a live sink. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Scheduled PCM still ahead of the audio clock; excludes downstream meeting capture. */
  get queuedAudioMs(): number {
    return Math.max(0, Math.round((this.nextStart - this.context.currentTime) * 1000));
  }

  async resume(): Promise<void> {
    if (this.context.state !== "running") await this.context.resume();
  }

  get isPlaying(): boolean {
    return this.sources.size > 0 || (this.streamActive && this.lastTapLevel > 0.01);
  }

  play(frame: PCMFrame, opts: { generationId?: number } = {}): boolean {
    if (frame.data.length === 0) return false;
    if (opts.generationId !== undefined && opts.generationId < this.killedBelow) {
      this.staleFramesDropped++;
      return false;
    }
    const data = frame.sampleRate === this.context.sampleRate ? frame.data : createResampler(frame.sampleRate, this.context.sampleRate).process(frame.data);
    const buffer = this.context.createBuffer(1, data.length, this.context.sampleRate);
    buffer.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = this.context.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    const t = this.context.currentTime;
    const start = Math.max(this.nextStart, t + this.leadSeconds);
    src.start(start);
    this.nextStart = start + buffer.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      src.disconnect();
    };
    return true;
  }

  attachStream(stream: MediaStream): void {
    this.detachStream();
    this.streamSource = this.context.createMediaStreamSource(stream);
    this.streamGain = this.context.createGain();
    this.streamSource.connect(this.streamGain);
    this.streamGain.connect(this.gain);
    this.streamActive = true;
  }

  detachStream(): void {
    if (this.streamSource) {
      this.streamSource.disconnect();
      this.streamSource = null;
    }
    if (this.streamGain) {
      this.streamGain.disconnect();
      this.streamGain = null;
    }
    this.streamActive = false;
  }

  /**
   * Hard stop: scheduled buffers stop now and an attached WebRTC stream is muted locally (the
   * provider's clear arrives later). With `minGeneration`, any later `play()` of an older
   * generation is refused, so late chunks can never re-start audio.
   */
  interrupt(minGeneration?: number): number {
    const t0 = performance.now();
    if (minGeneration !== undefined && minGeneration > this.killedBelow) this.killedBelow = minGeneration;
    if (this.streamGain) {
      this.streamGain.gain.cancelScheduledValues(this.context.currentTime);
      this.streamGain.gain.setValueAtTime(0, this.context.currentTime);
    }
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.sources.clear();
    this.nextStart = 0;
    return performance.now() - t0;
  }

  /** Same as `interrupt()`; exists so call sites that only clear the queue read naturally. */
  clearQueue(minGeneration?: number): number {
    return this.interrupt(minGeneration);
  }

  resumeStream(): void {
    if (this.streamGain) {
      this.streamGain.gain.cancelScheduledValues(this.context.currentTime);
      this.streamGain.gain.setValueAtTime(1, this.context.currentTime);
    }
  }

  /** Teardown order: stop sources → detach stream → dispose tap → disconnect gain → (owned) context.close(). Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interrupt();
    this.detachStream();
    this.tapNode?.dispose();
    this.tapNode = null;
    try {
      this.gain.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.ownsContext && (this.context.state as string) !== "closed") {
      await this.context.close().catch(() => {});
    }
  }
}
