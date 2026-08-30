import fs from "node:fs";
import path from "node:path";
import { commonPrefix, type StreamingSTTCapabilities, type StreamingTranscript } from "@rcai/provider-core";
import { loadSherpa } from "./sherpa.js";
import type { StreamingSTT } from "./stt-streaming.js";

interface OnlineRecognizerLike {
  createStream(): { acceptWaveform(o: { samples: Float32Array; sampleRate: number }): void; inputFinished(): void };
  isReady(s: unknown): boolean;
  decode(s: unknown): void;
  isEndpoint(s: unknown): boolean;
  reset(s: unknown): void;
  getResult(s: unknown): { text: string };
}

/**
 * True streaming recognizer (sherpa-onnx OnlineRecognizer, streaming zipformer transducer).
 * BLOCKED_BY_NO_JA_STREAMING_MODEL: as of 2026-08-30 the official sherpa-onnx list has no Japanese
 * streaming zipformer (only zh/en/ko/bn); the adapter is generic and verified with the zh-14M model
 * when present. Point `SHERPA_ONLINE_MODEL_DIR` at any streaming transducer directory.
 */
export class SherpaOnlineSTT implements StreamingSTT {
  readonly engine = "sherpa-onnx-online";
  model = "";
  ready = false;
  private recognizer: OnlineRecognizerLike | null = null;
  private stream: ReturnType<OnlineRecognizerLike["createStream"]> | null = null;
  private listeners = new Set<(t: StreamingTranscript) => void>();
  private last = "";
  private prev = "";
  partials = 0;

  constructor(private readonly modelDir: string | null, private readonly threads = 2) {}

  init(): void {
    const sherpa = loadSherpa() as unknown as { OnlineRecognizer?: new (cfg: Record<string, unknown>) => OnlineRecognizerLike } | null;
    if (!sherpa?.OnlineRecognizer || !this.modelDir || !fs.existsSync(this.modelDir)) return;
    const dir = this.modelDir;
    const pick = (prefix: string) => fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".onnx") && f.includes("int8")) ?? fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".onnx"));
    const enc = pick("encoder"), dec = pick("decoder"), joi = pick("joiner");
    if (!enc || !dec || !joi) return;
    try {
      this.recognizer = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { transducer: { encoder: path.join(dir, enc), decoder: path.join(dir, dec), joiner: path.join(dir, joi) }, tokens: path.join(dir, "tokens.txt"), numThreads: this.threads, provider: "cpu", debug: 0 },
        decodingMethod: "greedy_search",
        enableEndpoint: 0,
      });
      this.model = `online-zipformer:${path.basename(dir)}`;
      this.ready = true;
    } catch (err) {
      console.warn("[agent] sherpa online STT init failed:", (err as Error).message);
    }
  }

  /** Per-session instance sharing the loaded recognizer (streams are per instance). */
  clone(): SherpaOnlineSTT {
    const c = new SherpaOnlineSTT(this.modelDir, this.threads);
    c.recognizer = this.recognizer;
    c.model = this.model;
    c.ready = this.ready;
    return c;
  }

  capabilities(): StreamingSTTCapabilities {
    return { streaming: true, stablePrefix: true };
  }

  start(_language: string): void {
    this.reset();
  }

  onTranscript(cb: (t: StreamingTranscript) => void): void {
    this.listeners.add(cb);
  }

  pushAudio(samples: Float32Array): void {
    if (!this.recognizer) return;
    if (!this.stream) this.stream = this.recognizer.createStream();
    this.stream.acceptWaveform({ samples, sampleRate: 16000 });
    this.drain();
  }

  private drain(): void {
    if (!this.recognizer || !this.stream) return;
    let decoded = false;
    while (this.recognizer.isReady(this.stream)) { this.recognizer.decode(this.stream); decoded = true; }
    if (!decoded) return;
    const text = this.recognizer.getResult(this.stream).text.trim();
    if (text !== this.last) {
      this.prev = this.last;
      this.last = text;
      this.partials++;
      const stable = commonPrefix(this.prev, this.last);
      for (const l of this.listeners) { if (stable) l({ text: stable, kind: "stable" }); l({ text, kind: "partial" }); }
    }
  }

  async snapshot(_opts: { trailingSilenceMs?: number } = {}): Promise<StreamingTranscript> {
    this.drain();
    return { text: this.last, kind: "partial", reused: true };
  }

  async endUtterance(): Promise<StreamingTranscript> {
    if (this.recognizer && this.stream) {
      // pad with silence so the encoder can flush its right context
      this.stream.acceptWaveform({ samples: new Float32Array(16000 * 0.4), sampleRate: 16000 });
      this.stream.inputFinished();
      this.drain();
    }
    const final: StreamingTranscript = { text: this.last, kind: "final", reused: true };
    for (const l of this.listeners) l(final);
    return final;
  }

  get isStable(): boolean {
    return this.last.length > 0 && this.prev === this.last;
  }

  reset(): void {
    this.stream = null;
    this.last = "";
    this.prev = "";
    this.partials = 0;
  }
}
