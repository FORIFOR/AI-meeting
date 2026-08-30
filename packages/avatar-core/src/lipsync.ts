import { INTERNAL_SAMPLE_RATE, type PCMFrame } from "@rcai/audio-core";

export interface Visemes {
  a: number;
  i: number;
  u: number;
  e: number;
  o: number;
  silence: number;
}

export interface LipSyncOutput {
  /** 0..1 */
  mouthOpenY: number;
  /** -1 (narrow, u/o) .. 1 (wide, i/e) */
  mouthForm: number;
  visemes: Visemes;
  /** dBFS of the analysed window */
  levelDb: number;
}

/**
 * Pluggable lip-sync engine (spec §14). The default implementation analyses the
 * played PCM with a cheap formant heuristic. A Live2D MotionSync adapter can implement
 * the same interface when `live2dcubismmotionsynccore.min.js` is supplied.
 */
export interface LipSyncEngine {
  push(frame: PCMFrame): void;
  /** Latest output; safe to call every render frame. */
  sample(): LipSyncOutput;
  reset(): void;
}

export interface AnalyzerLipSyncOptions {
  /** Absolute level (dBFS) below which the mouth is always closed. Default -50. */
  floorDb?: number;
  /** Absolute level (dBFS) at/above which the mouth is fully open. Default -18. */
  ceilDb?: number;
  attackMs?: number;
  releaseMs?: number;
  /** Analysis window in ms (default 20). */
  windowMs?: number;
  /**
   * Adaptive gain: the open range follows the running speech peak, so a quiet voice (小声) still
   * opens the mouth. `dynamicRangeDb` is the span below the peak that maps to 0..1 (default 26);
   * the peak decays at `peakDecayDbPerSec` (default 2.5) so the range re-adapts after loud passages.
   */
  dynamicRangeDb?: number;
  peakDecayDbPerSec?: number;
  /** Wall clock used to detect that audio stopped arriving (default performance.now). */
  clock?: () => number;
}

const SILENT: LipSyncOutput = { mouthOpenY: 0, mouthForm: 0, visemes: { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 }, levelDb: -180 };

/** Goertzel band power at a center frequency. */
function goertzel(data: Float32Array, sampleRate: number, freq: number): number {
  const k = Math.round((data.length * freq) / sampleRate);
  const w = (2 * Math.PI * k) / data.length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < data.length; i++) {
    s0 = (data[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/** Band energy in dB (sum over the FFT bins inside [lo, hi]; Goertzel per bin, N is small). */
function bandDb(data: Float32Array, sampleRate: number, lo: number, hi: number): number {
  const binHz = sampleRate / data.length;
  const k0 = Math.max(1, Math.floor(lo / binHz));
  const k1 = Math.max(k0, Math.ceil(hi / binHz));
  let sum = 0;
  for (let k = k0; k <= k1; k++) sum += goertzel(data, sampleRate, k * binHz);
  return 10 * Math.log10(sum / data.length + 1e-12);
}

function hann(data: Float32Array): Float32Array {
  const out = new Float32Array(data.length);
  const n = data.length - 1;
  for (let i = 0; i < data.length; i++) out[i] = (data[i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  return out;
}

export class AnalyzerLipSync implements LipSyncEngine {
  private readonly opts: Required<Omit<AnalyzerLipSyncOptions, "clock">>;
  private buffer: Float32Array;
  private filled = 0;
  private out: LipSyncOutput = { ...SILENT, visemes: { ...SILENT.visemes } };
  private open = 0;
  private form = 0;
  private lastAt = 0;
  private sampleRate = INTERNAL_SAMPLE_RATE;
  private peakDb = -60;
  private lastPushWallAt = 0;
  private readonly clock: () => number;

  constructor(opts: AnalyzerLipSyncOptions = {}) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.opts = {
      floorDb: opts.floorDb ?? -50,
      ceilDb: opts.ceilDb ?? -18,
      attackMs: opts.attackMs ?? 12,
      releaseMs: opts.releaseMs ?? 45,
      windowMs: opts.windowMs ?? 20,
      dynamicRangeDb: opts.dynamicRangeDb ?? 26,
      peakDecayDbPerSec: opts.peakDecayDbPerSec ?? 2.5,
    };
    this.buffer = new Float32Array(Math.round((this.opts.windowMs / 1000) * this.sampleRate));
  }

  push(frame: PCMFrame): void {
    this.lastPushWallAt = this.clock();
    if (frame.sampleRate !== this.sampleRate) {
      this.sampleRate = frame.sampleRate;
      this.buffer = new Float32Array(Math.round((this.opts.windowMs / 1000) * this.sampleRate));
      this.filled = 0;
    }
    let offset = 0;
    while (offset < frame.data.length) {
      const take = Math.min(this.buffer.length - this.filled, frame.data.length - offset);
      this.buffer.set(frame.data.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled >= this.buffer.length) {
        this.analyze(frame.timestamp + (offset / frame.sampleRate) * 1000);
        this.filled = 0;
      }
    }
  }

  private analyze(at: number): void {
    const data = this.buffer;
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += (data[i] ?? 0) ** 2;
    const rmsV = Math.sqrt(sum / data.length);
    const levelDb = rmsV <= 1e-9 ? -180 : 20 * Math.log10(rmsV);
    const dt = this.lastAt ? Math.max(1, at - this.lastAt) : this.opts.windowMs;
    this.lastAt = at;

    // Adaptive gain: instant-attack / slow-decay peak tracker; never below floorDb+8 so noise stays shut.
    this.peakDb = Math.max(this.peakDb - this.opts.peakDecayDbPerSec * (dt / 1000), levelDb, this.opts.floorDb + 8);
    const ceil = Math.min(this.opts.ceilDb, this.peakDb - 3);
    const floor = Math.max(this.opts.floorDb, ceil - this.opts.dynamicRangeDb);
    const targetOpen = Math.max(0, Math.min(1, (levelDb - floor) / (ceil - floor)));

    // Vowel shape from band energies relative to the fundamental region (250–600 Hz).
    // Calibrated on a Japanese TTS corpus (tools/lipsync-corpus): hi = max(1900–2800, 2800–4000) − low
    // orders i(−16) > a(−18) > e(−21) > u(−24) > o(−29) dB; mid = 600–1300 − low is largest for a/o.
    let targetForm = this.form;
    let visemes: Visemes = { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 };
    if (targetOpen > 0.08) {
      const sr = this.sampleRate;
      const win = hann(data);
      const low = bandDb(win, sr, 250, 600);
      const mid = bandDb(win, sr, 600, 1300) - low;
      const h2 = bandDb(win, sr, 1900, 2800);
      const h3 = bandDb(win, sr, 2800, 4000);
      const hi = Math.max(h2, h3) - low; // max: robust when one band is empty (synthetic/telephone audio)
      // +1 = wide (a/i/e, Live2D ParamMouthForm +), −1 = narrow/pucker (u/o).
      targetForm = Math.max(-1, Math.min(1, (hi + 23) / 5));
      const wide = Math.max(0, Math.min(1, (hi + 25) / 8));
      const openA = Math.max(0, Math.min(1, (mid + 12) / 6));
      const hiOnly = Math.max(0, Math.min(1, (h3 - h2 + 2) / 6));
      const iShare = Math.max(hiOnly, 0.5); // wide + no mid → i/e; extra 2.8–4 kHz energy tips it to i
      visemes = {
        a: openA * (1 - 0.5 * hiOnly) * targetOpen,
        i: wide * iShare * (1 - openA) * targetOpen,
        e: wide * (1 - iShare) * (1 - openA) * targetOpen,
        u: (1 - wide) * (1 - openA) * targetOpen,
        o: (1 - wide) * openA * targetOpen,
        silence: 1 - targetOpen,
      };
    }

    const tau = targetOpen > this.open ? this.opts.attackMs : this.opts.releaseMs;
    const alpha = 1 - Math.exp(-dt / tau);
    this.open += (targetOpen - this.open) * alpha;
    this.form += (targetForm - this.form) * (1 - Math.exp(-dt / 60));
    // Wide vowels open a little more than puckered ones at the same level.
    const shaped = this.open * (0.8 + 0.2 * Math.max(0, this.form));
    this.out = { mouthOpenY: shaped, mouthForm: this.form, visemes, levelDb };
  }

  /**
   * Latest output. When the audio tap goes quiet (no frames for > 2 windows — playback ended, the
   * worklet stops posting), the mouth decays toward closed instead of freezing at the last value.
   */
  sample(): LipSyncOutput {
    if (this.lastPushWallAt && this.open > 0) {
      const idle = this.clock() - this.lastPushWallAt;
      if (idle > this.opts.windowMs * 2) {
        const alpha = 1 - Math.exp(-(idle - this.opts.windowMs * 2) / this.opts.releaseMs);
        const open = this.open * (1 - alpha);
        const shaped = open * (0.8 + 0.2 * Math.max(0, this.form));
        this.out = { ...this.out, mouthOpenY: shaped < 0.005 ? 0 : shaped, visemes: { ...this.out.visemes, silence: 1 - shaped } };
        if (shaped < 0.005) {
          this.open = 0;
          this.lastPushWallAt = 0;
        }
      }
    }
    return this.out;
  }

  reset(): void {
    this.filled = 0;
    this.open = 0;
    this.form = 0;
    this.lastAt = 0;
    this.peakDb = -60;
    this.lastPushWallAt = 0;
    this.out = { ...SILENT, visemes: { ...SILENT.visemes } };
  }
}
