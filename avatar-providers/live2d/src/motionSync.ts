import type { LipSyncEngine, LipSyncOutput } from "@rcai/avatar-core";
import { INTERNAL_SAMPLE_RATE, createResampler, type PCMFrame, type Resampler } from "@rcai/audio-core";
import { DEFAULT_VENDOR_MOTIONSYNC_CORE_URL, loadScriptOnce } from "./core.js";
import { MOTIONSYNC_CORE_GLOBAL, getMotionSyncCore, type MotionSyncCoreApi } from "./motionsync/coreApi.js";
import { parseMotionSyncJson, type MotionSyncData } from "./motionsync/data.js";
import { MotionSyncCriEngine } from "./motionsync/engine.js";
import { CubismMotionSync, type ParameterModel, type ParameterWrite } from "./motionsync/cubismMotionSync.js";

export class MotionSyncUnavailableError extends Error {
  readonly code = "BLOCKED_BY_MOTIONSYNC_CORE";
  constructor(detail: string) {
    super(`BLOCKED_BY_MOTIONSYNC_CORE: ${detail}. Download the Cubism MotionSync Plugin for Web from https://www.live2d.com/en/sdk/download/motionsync/ and place live2dcubismmotionsynccore.min.js at vendor/live2d/.`);
    this.name = "MotionSyncUnavailableError";
  }
}

export interface MotionSyncLipSyncOptions {
  /** URL of `live2dcubismmotionsynccore.min.js` (default: vendored path). Ignored when `core` is given. */
  coreUrl?: string;
  /** Pre-loaded Core object (tests / custom loaders). */
  core?: MotionSyncCoreApi;
  /** Parsed or raw `.motionsync3.json`. */
  motionSync: string | object | MotionSyncData;
  /** The model whose parameters MotionSync drives (pixi-live2d-display coreModel adapter). */
  model: ParameterModel;
  /** Audio sample rate handed to the Core (16k..128k). Frames are resampled to it. Default 48000. */
  sampleRate?: number;
  clock?: () => number;
  /** Ids used to derive LipSyncOutput from parameter writes. */
  mouthOpenId?: string;
  mouthFormId?: string;
}

/**
 * Live2D MotionSync lip sync (spec §14 primary path).
 *
 * Audio actually played (SpeakerOutput.tap) → `push()` → sample queue → Core analysis at the
 * setting's fps → smoothed/damped parameter values → written straight into the model
 * (ParamMouthOpenY/ParamMouthForm or ParamA/I/U/E/O …) and mirrored into `LipSyncOutput` so the
 * MotionStack's mouth channel matches.
 *
 * The proprietary Core is not in the repository: `create()` throws `MotionSyncUnavailableError`
 * (BLOCKED_BY_MOTIONSYNC_CORE) unless the script can be loaded or `core` is injected.
 */
export class MotionSyncLipSync implements LipSyncEngine {
  static async create(opts: MotionSyncLipSyncOptions): Promise<MotionSyncLipSync> {
    let core = opts.core ?? getMotionSyncCore();
    if (!core) {
      const url = opts.coreUrl ?? DEFAULT_VENDOR_MOTIONSYNC_CORE_URL;
      try {
        await loadScriptOnce(url, MOTIONSYNC_CORE_GLOBAL);
      } catch (e) {
        throw new MotionSyncUnavailableError(`core script not available at ${url} (${(e as Error).message})`);
      }
      core = getMotionSyncCore();
      if (!core) throw new MotionSyncUnavailableError(`${url} loaded but ${MOTIONSYNC_CORE_GLOBAL} is missing`);
    }
    const data = isMotionSyncData(opts.motionSync) ? opts.motionSync : parseMotionSyncJson(opts.motionSync);
    if (!data.settings.some((s) => s.analysisType === "CRI")) throw new MotionSyncUnavailableError("motionsync3.json has no CRI setting");
    MotionSyncCriEngine.initialize(core);
    const sampleRate = opts.sampleRate ?? INTERNAL_SAMPLE_RATE;
    const sync = CubismMotionSync.create(opts.model, data, sampleRate);
    if (sync.processorCount === 0) throw new MotionSyncUnavailableError("no MotionSync processor could be created");
    return new MotionSyncLipSync(sync, data, sampleRate, opts);
  }

  readonly engine = "motionsync" as const;
  private queue: number[] = [];
  private resampler: Resampler | null = null;
  private lastUpdateAt = 0;
  private out: LipSyncOutput = silent();
  private writes: ParameterWrite[] = [];
  private levelDb = -180;
  private readonly clock: () => number;
  private readonly mouthOpenId: string;
  private readonly mouthFormId: string;

  private constructor(readonly sync: CubismMotionSync, readonly data: MotionSyncData, readonly sampleRate: number, opts: MotionSyncLipSyncOptions) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.mouthOpenId = opts.mouthOpenId ?? "ParamMouthOpenY";
    this.mouthFormId = opts.mouthFormId ?? "ParamMouthForm";
  }

  /** Queue played PCM (any sample rate; resampled to the Core's rate). */
  push(frame: PCMFrame): void {
    let data = frame.data;
    if (frame.sampleRate !== this.sampleRate) {
      if (!this.resampler || this.resampler.from !== frame.sampleRate) this.resampler = createResampler(frame.sampleRate, this.sampleRate);
      data = this.resampler.process(frame.data);
    }
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] ?? 0;
      sum += v * v;
      this.queue.push(v);
    }
    const rms = data.length ? Math.sqrt(sum / data.length) : 0;
    this.levelDb = rms <= 1e-9 ? -180 : 20 * Math.log10(rms);
    // Keep at most ~1 s queued (the Core consumes requireSampleCount per analysis tick).
    const cap = this.sampleRate;
    if (this.queue.length > cap) this.queue.splice(0, this.queue.length - cap);
  }

  /** Run the Core for the elapsed time and return the latest mouth values. Call once per render frame. */
  sample(): LipSyncOutput {
    const now = this.clock();
    const dt = this.lastUpdateAt ? Math.min(0.25, Math.max(0, (now - this.lastUpdateAt) / 1000)) : 1 / 60;
    this.lastUpdateAt = now;
    this.update(dt);
    return this.out;
  }

  /** Explicit stepping (tests / offline harness). */
  update(dtSeconds: number): ParameterWrite[] {
    this.sync.setSoundBuffer(0, this.queue, 0);
    this.writes = this.sync.updateParameters(dtSeconds);
    const processed = this.sync.getLastTotalProcessedCount(0);
    if (processed > 0) this.queue.splice(0, processed);
    const open = this.writes.find((w) => w.id === this.mouthOpenId)?.value;
    const form = this.writes.find((w) => w.id === this.mouthFormId)?.value ?? 0;
    const visemeOf = (id: string) => this.writes.find((w) => w.id === id)?.value ?? 0;
    const mouthOpenY = Math.max(0, Math.min(1, open ?? Math.max(visemeOf("ParamA"), visemeOf("ParamI"), visemeOf("ParamU"), visemeOf("ParamE"), visemeOf("ParamO"))));
    this.out = {
      mouthOpenY,
      mouthForm: Math.max(-1, Math.min(1, form)),
      visemes: { a: visemeOf("ParamA"), i: visemeOf("ParamI"), u: visemeOf("ParamU"), e: visemeOf("ParamE"), o: visemeOf("ParamO"), silence: 1 - mouthOpenY },
      levelDb: this.levelDb,
    };
    return this.writes;
  }

  /** Parameter values the Core wrote in the last update (ids from the motionsync3 setting). */
  getParameterWrites(): ParameterWrite[] {
    return this.writes;
  }

  reset(): void {
    this.queue = [];
    this.resampler?.reset();
    this.lastUpdateAt = 0;
    this.sync.reset();
    this.writes = [];
    this.out = silent();
    this.levelDb = -180;
  }

  dispose(): void {
    this.sync.release();
  }
}

function silent(): LipSyncOutput {
  return { mouthOpenY: 0, mouthForm: 0, visemes: { a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 }, levelDb: -180 };
}

function isMotionSyncData(v: unknown): v is MotionSyncData {
  return typeof v === "object" && v !== null && Array.isArray((v as MotionSyncData).settings) && "dictionary" in (v as object);
}
