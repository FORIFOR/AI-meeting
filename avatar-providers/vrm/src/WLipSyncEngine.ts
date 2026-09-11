import type { PCMFrame } from "@rcai/audio-core";
import { AnalyzerLipSync, type LipSyncEngine, type LipSyncOutput, type Visemes } from "@rcai/avatar-core";
import type { LipSyncWorker, LipSyncWorkerInput, LipSyncWorkerOutput } from "./wlipsyncProtocol.js";

type AudioJob = Extract<LipSyncWorkerInput, { type: "audio" }>;
type Result = Extract<LipSyncWorkerOutput, { type: "result" }>;
const VOWELS = ["a", "i", "u", "e", "o"] as const;
const silentVisemes = (): Visemes => ({ a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 });

export interface WLipSyncEngineOptions {
  clock?: () => number;
  /** Injection point for lifecycle tests. Production uses a same-origin module Worker. */
  createWorker?: () => LipSyncWorker;
  fallback?: LipSyncEngine;
}

/**
 * Observes played PCM only. Its worker never plays or schedules audio. Pending analysis
 * is bounded to one executing and one latest job, so slow WASM cannot delay playback.
 * The synchronous analyser remains available during setup, failure or stale results.
 */
export class WLipSyncEngine implements LipSyncEngine {
  private readonly clock: () => number;
  private readonly fallback: LipSyncEngine;
  private worker: LipSyncWorker | null = null;
  private ready = false;
  private state: "idle" | "loading" | "ready" | "failed" | "disposed" = "idle";
  private generation = 0;
  private sequence = 0;
  private inFlight: number | null = null;
  private pending: AudioJob | null = null;
  private result: Result | null = null;
  private buffer = new Float32Array(960);
  private filled = 0;
  private sampleRate = 48000;
  private lastPushAt = -Infinity;
  private lastSampleAt = 0;
  private weights = silentVisemes();
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: WLipSyncEngineOptions = {}) {
    this.clock = options.clock ?? (() => performance.now());
    this.fallback = options.fallback ?? new AnalyzerLipSync({ clock: this.clock });
  }

  /** Fire and forget. Neither avatar preparation nor the audio path waits for WASM. */
  start(): void {
    if (this.state !== "idle" && this.state !== "disposed") return;
    this.state = "loading";
    try {
      const worker = this.options.createWorker?.() ?? new Worker(new URL("./wlipsync.worker.ts", import.meta.url), { type: "module" });
      this.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === "failed") { this.fail(); return; }
        if (data.type === "ready") {
          if (this.deadline) clearTimeout(this.deadline);
          this.deadline = null;
          this.ready = true;
          this.state = "ready";
          return;
        }
        if (data.sequence !== this.inFlight) return;
        this.inFlight = null;
        if (data.generation === this.generation && this.clock() - data.at <= 120) this.result = data;
        const pending = this.pending;
        this.pending = null;
        if (pending && this.clock() - pending.at <= 120) this.submit(pending);
      };
      worker.onerror = () => this.fail();
      this.deadline = setTimeout(() => this.fail(), 5000);
    } catch { this.fail(); }
  }

  push(frame: PCMFrame): void {
    if (this.state === "disposed") return;
    this.fallback.push(frame);
    this.lastPushAt = this.clock();
    if (!this.ready) return; // Never replay PCM received while WASM was loading.
    if (frame.sampleRate !== this.sampleRate) {
      this.sampleRate = frame.sampleRate;
      this.buffer = new Float32Array(Math.max(1, Math.round(frame.sampleRate * 0.02)));
      this.filled = 0;
    }
    let offset = 0;
    while (offset < frame.data.length) {
      const count = Math.min(this.buffer.length - this.filled, frame.data.length - offset);
      this.buffer.set(frame.data.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === this.buffer.length) {
        const job: AudioJob = { type: "audio", generation: this.generation, sequence: ++this.sequence,
          at: this.lastPushAt, sampleRate: frame.sampleRate, data: this.buffer };
        this.buffer = new Float32Array(this.buffer.length);
        this.filled = 0;
        if (this.inFlight === null) this.submit(job);
        else this.pending = job;
      }
    }
  }

  private submit(job: AudioJob): void {
    try {
      this.inFlight = job.sequence;
      this.worker?.postMessage(job, [job.data.buffer as ArrayBuffer]);
    } catch { this.fail(); }
  }

  sample(): LipSyncOutput {
    const fallback = this.fallback.sample();
    const now = this.clock();
    const dt = Math.max(1, Math.min(60, now - this.lastSampleAt));
    this.lastSampleAt = now;
    // Both silence PCM and cessation of SpeakerOutput.tap close the mouth. In particular,
    // a late worker reply must never extend a completed / interrupted audible turn.
    if (now - this.lastPushAt > 100 || fallback.levelDb < -50) {
      this.weights = silentVisemes();
      return { ...fallback, mouthOpenY: 0, mouthForm: 0, visemes: this.weights };
    }
    const result = this.result;
    if (!result || result.generation !== this.generation || now - result.at > 120 || !this.ready) return fallback;
    const vowel = result.name.toLowerCase();
    if (!(VOWELS as readonly string[]).includes(vowel)) return fallback;
    const alpha = 1 - Math.exp(-dt / 25);
    for (const key of VOWELS) this.weights[key] += ((key === vowel ? 1 : 0) - this.weights[key]) * alpha;
    const sum = VOWELS.reduce((total, key) => total + this.weights[key], 0) || 1;
    const open = fallback.mouthOpenY;
    const visemes = silentVisemes();
    for (const key of VOWELS) visemes[key] = this.weights[key] / sum * open;
    visemes.silence = 1 - open;
    return { mouthOpenY: open, mouthForm: (visemes.i + visemes.e - visemes.u - visemes.o) / Math.max(0.001, open),
      visemes, levelDb: fallback.levelDb };
  }

  reset(): void {
    this.generation++;
    this.pending = null;
    this.result = null;
    this.filled = 0;
    this.lastPushAt = -Infinity;
    this.weights = silentVisemes();
    this.fallback.reset();
    // Keep inFlight until its acknowledgement: cancellation cannot create an unbounded queue.
    if (this.ready) {
      try { this.worker?.postMessage({ type: "reset", generation: this.generation }); }
      catch { this.fail(); }
    }
  }

  getDiagnostics(): { requested: "wlipsync"; actual: "wlipsync" | "analyzer"; state: string } {
    return { requested: "wlipsync", actual: this.ready && this.result !== null && this.clock() - this.result.at <= 120 ? "wlipsync" : "analyzer", state: this.state };
  }

  private fail(): void {
    this.releaseWorker();
    this.state = "failed";
  }

  private releaseWorker(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
    this.result = null;
    this.pending = null;
    this.inFlight = null;
  }

  dispose(): void {
    this.releaseWorker();
    this.reset();
    this.state = "disposed";
  }
}
