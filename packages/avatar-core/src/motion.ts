import { PARAM_NAMES, clampParams, neutralParams, type AvatarParams, type MotionCategory, type ParamName } from "./types.js";

export type Ease = "linear" | "in" | "out" | "inOut";

export interface Keyframe {
  /** ms from clip start */
  t: number;
  v: number;
  ease?: Ease;
}

/** Procedural, renderer-agnostic motion clip (works for Live2D params, VRM bones, canvas). */
export interface MotionClip {
  id: string;
  category: MotionCategory;
  tags?: string[];
  durationMs: number;
  loop: boolean;
  /** Curves are additive offsets to the neutral pose. */
  curves: Partial<Record<ParamName, Keyframe[]>>;
  fadeInMs?: number;
  fadeOutMs?: number;
  /** 0..1 how energetic; used by the library to pick by context. */
  energy?: number;
}

export function ease(k: Ease | undefined, x: number): number {
  switch (k) {
    case "in":
      return x * x;
    case "out":
      return 1 - (1 - x) * (1 - x);
    case "inOut":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    default:
      return x;
  }
}

export function sampleCurve(frames: Keyframe[], t: number): number {
  if (frames.length === 0) return 0;
  if (t <= frames[0]!.t) return frames[0]!.v;
  const last = frames[frames.length - 1]!;
  if (t >= last.t) return last.v;
  for (let i = 1; i < frames.length; i++) {
    const b = frames[i]!;
    if (t <= b.t) {
      const a = frames[i - 1]!;
      const span = b.t - a.t || 1;
      const x = ease(b.ease, (t - a.t) / span);
      return a.v + (b.v - a.v) * x;
    }
  }
  return last.v;
}

export function sampleClip(clip: MotionClip, tMs: number): Partial<AvatarParams> {
  const t = clip.loop ? ((tMs % clip.durationMs) + clip.durationMs) % clip.durationMs : Math.min(tMs, clip.durationMs);
  const out: Partial<AvatarParams> = {};
  for (const key of Object.keys(clip.curves) as ParamName[]) {
    out[key] = sampleCurve(clip.curves[key]!, t);
  }
  return out;
}

/** Spec §11 layers, bottom to top. */
export type MotionLayer = "idle" | "faceMicro" | "gaze" | "speech" | "emotion" | "gesture";
export const MOTION_LAYERS: MotionLayer[] = ["idle", "faceMicro", "gaze", "speech", "emotion", "gesture"];

interface ClipInstance {
  clip: MotionClip;
  startedAt: number;
  weight: number;
  /** when set, the instance fades out to 0 from this time */
  fadeOutFrom?: number;
  scale: number;
}

interface LayerState {
  current: ClipInstance | null;
  previous: ClipInstance | null;
  /** Procedural values (blink, gaze, breathing) — additive except eye open which multiplies. */
  procedural: Partial<AvatarParams>;
  /** Absolute targets blended by intensity (emotion expressions). */
  absolute: { params: Partial<AvatarParams>; intensity: number } | null;
}

export interface LipSyncInput {
  mouthOpenY: number;
  mouthForm: number;
}

/**
 * Motion Stack (spec §11): composes six layers plus lip sync into one AvatarParams.
 * - idle / speech / gesture: additive clips with crossfade
 * - faceMicro / gaze: procedural additive (eyeOpen multiplies)
 * - emotion: absolute expression targets blended by intensity
 * - lip sync: overrides mouth params, only while `speaking` (mouth is forced shut otherwise)
 */
export class MotionStack {
  private layers: Record<MotionLayer, LayerState>;
  private lip: LipSyncInput = { mouthOpenY: 0, mouthForm: 0 };
  private speaking = false;
  private last: AvatarParams = neutralParams();
  private smoothed: AvatarParams = neutralParams();
  /** Per-param smoothing (higher = snappier). */
  smoothing = 18;

  constructor(private readonly clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {
    this.layers = Object.fromEntries(MOTION_LAYERS.map((l) => [l, { current: null, previous: null, procedural: {}, absolute: null }])) as Record<MotionLayer, LayerState>;
  }

  play(layer: MotionLayer, clip: MotionClip, opts: { scale?: number; at?: number } = {}): void {
    const at = opts.at ?? this.clock();
    const state = this.layers[layer];
    if (state.current) {
      state.previous = { ...state.current, fadeOutFrom: at };
    }
    state.current = { clip, startedAt: at, weight: 0, scale: opts.scale ?? 1 };
  }

  /** Stop the clip on a layer (with fade-out). */
  clear(layer: MotionLayer, at: number = this.clock()): void {
    const state = this.layers[layer];
    if (state.current) state.previous = { ...state.current, fadeOutFrom: at };
    state.current = null;
  }

  /** Immediate stop (no fade): used on interruption for speech + gesture layers. */
  cut(layer: MotionLayer): void {
    const state = this.layers[layer];
    state.current = null;
    state.previous = null;
  }

  currentClip(layer: MotionLayer): MotionClip | null {
    return this.layers[layer].current?.clip ?? null;
  }

  setProcedural(layer: MotionLayer, params: Partial<AvatarParams>): void {
    this.layers[layer].procedural = params;
  }

  setAbsolute(layer: MotionLayer, params: Partial<AvatarParams> | null, intensity = 1): void {
    this.layers[layer].absolute = params ? { params, intensity } : null;
  }

  setLipSync(input: LipSyncInput): void {
    this.lip = input;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) this.lip = { mouthOpenY: 0, mouthForm: 0 };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Compose all layers at time `at`. `dtMs` drives smoothing. */
  compose(at: number = this.clock(), dtMs = 16): AvatarParams {
    const out = neutralParams();
    let eyeMulL = 1;
    let eyeMulR = 1;
    for (const layerName of MOTION_LAYERS) {
      const layer = this.layers[layerName];
      // Clips
      for (const inst of [layer.previous, layer.current]) {
        if (!inst) continue;
        const clip = inst.clip;
        const elapsed = at - inst.startedAt;
        if (!clip.loop && elapsed > clip.durationMs + (clip.fadeOutMs ?? 200)) {
          if (inst === layer.current) layer.current = null;
          else layer.previous = null;
          continue;
        }
        let w = 1;
        const fi = clip.fadeInMs ?? 150;
        if (fi > 0) w = Math.min(1, elapsed / fi);
        const fo = clip.fadeOutMs ?? 200;
        if (inst.fadeOutFrom !== undefined) {
          w *= Math.max(0, 1 - (at - inst.fadeOutFrom) / fo);
          if (w <= 0) {
            layer.previous = null;
            continue;
          }
        } else if (!clip.loop && elapsed > clip.durationMs) {
          w *= Math.max(0, 1 - (elapsed - clip.durationMs) / fo);
        }
        const sampled = sampleClip(clip, elapsed);
        for (const k of Object.keys(sampled) as ParamName[]) {
          const v = (sampled[k] ?? 0) * w * inst.scale;
          if (k === "eyeLOpen") eyeMulL *= 1 + v;
          else if (k === "eyeROpen") eyeMulR *= 1 + v;
          else out[k] += v;
        }
      }
      // Procedural
      for (const k of Object.keys(layer.procedural) as ParamName[]) {
        const v = layer.procedural[k] ?? 0;
        if (k === "eyeLOpen") eyeMulL *= v;
        else if (k === "eyeROpen") eyeMulR *= v;
        else out[k] += v;
      }
      // Absolute blends (emotion)
      if (layer.absolute) {
        const { params, intensity } = layer.absolute;
        for (const k of Object.keys(params) as ParamName[]) {
          const target = params[k] ?? 0;
          if (k === "eyeLOpen") eyeMulL *= 1 + (target - 1) * intensity;
          else if (k === "eyeROpen") eyeMulR *= 1 + (target - 1) * intensity;
          else out[k] += (target - out[k]) * intensity;
        }
      }
    }
    out.eyeLOpen = Math.max(0, out.eyeLOpen * eyeMulL);
    out.eyeROpen = Math.max(0, out.eyeROpen * eyeMulR);

    // Smooth everything except the mouth (lip sync must be immediate).
    const alpha = 1 - Math.exp(-this.smoothing * (dtMs / 1000));
    for (const k of PARAM_NAMES) {
      if (k === "mouthOpenY" || k === "mouthForm" || k === "eyeLOpen" || k === "eyeROpen") continue;
      this.smoothed[k] += (out[k] - this.smoothed[k]) * alpha;
      out[k] = this.smoothed[k];
    }
    // Blink must not be smoothed away: take eye open directly.
    out.eyeLOpen = Math.max(0, Math.min(1.5, out.eyeLOpen));
    out.eyeROpen = Math.max(0, Math.min(1.5, out.eyeROpen));

    // Lip sync overrides mouth; a silent avatar never moves its mouth (spec §10).
    if (this.speaking) {
      out.mouthOpenY = Math.max(0, Math.min(1, this.lip.mouthOpenY));
      out.mouthForm = Math.max(-1, Math.min(1, out.mouthForm * 0.4 + this.lip.mouthForm));
    } else {
      out.mouthOpenY = 0;
    }
    this.last = clampParams(out);
    return { ...this.last };
  }

  getLast(): AvatarParams {
    return { ...this.last };
  }

  resetSmoothing(): void {
    this.smoothed = neutralParams();
  }
}
