import { commonPrefix, type StreamingSTTCapabilities, type StreamingTranscript } from "@rcai/provider-core";
import type { STTAdapter } from "./stt.js";

/**
 * Agent-side streaming STT (16 kHz float samples). Mirrors the provider-core contract but adds
 * `snapshot()` so the session can read the current transcript at a pause without ending the
 * utterance (the endpoint policy may decide the user is still talking).
 */
export interface StreamingSTT {
  readonly engine: string;
  readonly model: string;
  readonly ready: boolean;
  capabilities(): StreamingSTTCapabilities;
  start(language: string): void;
  pushAudio(samples: Float32Array): void;
  onTranscript(cb: (t: StreamingTranscript) => void): void;
  /**
   * Current best transcript (decodes if the last partial is stale). Does not end the utterance.
   * `trailingSilenceMs`: audio at the end already known to be silence (excluded from the staleness check).
   */
  snapshot(opts?: { trailingSilenceMs?: number }): Promise<StreamingTranscript>;
  /** The last decode only appended to the previous one (tail unchanged). */
  readonly isStable: boolean;
  endUtterance(): Promise<StreamingTranscript>;
  reset(): void;
  readonly partials: number;
}

export interface IncrementalOptions {
  /** Minimum audio (ms) between two incremental decodes. Default 300. */
  intervalMs?: number;
  /** A final is served from the last partial when it already covers all but this much tail audio (ms). Default 150. */
  reuseTailMs?: number;
  /** Do not decode before this much audio exists (ms). Default 400. */
  minAudioMs?: number;
  language?: string;
  clock?: () => number;
}

/**
 * Incremental re-decoding on top of an offline recognizer (SenseVoice / zipformer): every
 * `intervalMs` of new audio the whole utterance is decoded again on a serial queue (skipped while a
 * decode is running). The stable prefix is the common prefix of the last two partials. At speech
 * end the final is reused when the last decode is fresh, removing the post-end STT wait.
 */
export class IncrementalOfflineSTT implements StreamingSTT {
  readonly engine: string;
  readonly model: string;
  private chunks: Float32Array[] = [];
  private total = 0;
  private decodedUpTo = 0; // samples covered by the last completed decode
  private lastPartial = "";
  private prevPartial = "";
  private stable = "";
  private decoding: Promise<void> | null = null;
  private listeners = new Set<(t: StreamingTranscript) => void>();
  private language: string;
  private readonly o: Required<Omit<IncrementalOptions, "clock" | "language">>;
  partials = 0;
  /** Sample position of the last known end of speech (silence after it is not "new audio"). */
  private speechEndSample: number | null = null;

  constructor(private readonly base: STTAdapter, opts: IncrementalOptions = {}) {
    this.engine = `incremental(${base.engine})`;
    this.model = base.model;
    this.language = opts.language ?? "ja-JP";
    this.o = { intervalMs: opts.intervalMs ?? 250, reuseTailMs: opts.reuseTailMs ?? 150, minAudioMs: opts.minAudioMs ?? 400 };
  }

  get ready(): boolean {
    return this.base.ready;
  }

  capabilities(): StreamingSTTCapabilities {
    return { streaming: true, stablePrefix: true };
  }

  start(language: string): void {
    this.language = language;
    this.reset();
  }

  onTranscript(cb: (t: StreamingTranscript) => void): void {
    this.listeners.add(cb);
  }

  pushAudio(samples: Float32Array): void {
    this.chunks.push(samples);
    this.total += samples.length;
    const newMs = ((this.total - this.decodedUpTo) / 16000) * 1000;
    if (!this.decoding && this.total >= (this.o.minAudioMs / 1000) * 16000 && newMs >= this.o.intervalMs) {
      this.decoding = this.decodeAll("partial").finally(() => (this.decoding = null));
    }
  }

  /** Fresh transcript: reuse when the last decode covers all but `reuseTailMs` of speech, else decode now. */
  async snapshot(opts: { trailingSilenceMs?: number } = {}): Promise<StreamingTranscript> {
    if (this.decoding) await this.decoding;
    const silence = Math.round(((opts.trailingSilenceMs ?? 0) / 1000) * 16000);
    const tailMs = (Math.max(0, this.total - silence - this.decodedUpTo) / 16000) * 1000;
    if (this.lastPartial && tailMs <= this.o.reuseTailMs) {
      return { text: this.lastPartial, kind: "partial", reused: true };
    }
    if (this.total === 0) return { text: "", kind: "partial", reused: false };
    this.decoding = this.decodeAll("partial").finally(() => (this.decoding = null));
    await this.decoding;
    return { text: this.lastPartial, kind: "partial", reused: false };
  }

  async endUtterance(): Promise<StreamingTranscript> {
    const snap = await this.snapshot();
    const final: StreamingTranscript = { text: snap.text, kind: "final", reused: snap.reused };
    for (const l of this.listeners) l(final);
    return final;
  }

  /** Tail of the transcript unchanged between the last two decodes (common prefix covers all of the previous). */
  get stableText(): string {
    return this.stable;
  }

  get isStable(): boolean {
    const norm = (t: string) => t.replace(/[\s\u3000]+/g, "").replace(/[。．.、,？?！!…]+$/, "");
    const prev = norm(this.prevPartial);
    const last = norm(this.lastPartial);
    return prev.length > 0 && last.startsWith(prev);
  }

  reset(): void {
    this.chunks = [];
    this.total = 0;
    this.decodedUpTo = 0;
    this.lastPartial = "";
    this.prevPartial = "";
    this.stable = "";
    this.partials = 0;
  }

  private async decodeAll(kind: "partial"): Promise<void> {
    const upTo = this.total;
    const merged = new Float32Array(upTo);
    let off = 0;
    for (const c of this.chunks) { merged.set(c, off); off += c.length; }
    let text: string;
    try {
      text = await this.base.transcribe(merged, 16000, this.language);
    } catch {
      return;
    }
    // A newer reset happened while decoding: discard.
    if (upTo > this.total) return;
    this.decodedUpTo = upTo;
    this.prevPartial = this.lastPartial;
    this.lastPartial = text;
    this.stable = commonPrefix(this.prevPartial, this.lastPartial);
    this.partials++;
    const stableT: StreamingTranscript = { text: this.stable, kind: "stable" };
    const partialT: StreamingTranscript = { text, kind };
    for (const l of this.listeners) { if (this.stable) l(stableT); l(partialT); }
  }
}
