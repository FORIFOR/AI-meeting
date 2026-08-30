import type { PCMFrame } from "@rcai/audio-core";
import { MotionStack, type MotionClip, type MotionLayer } from "./motion.js";
import { MotionLibrary } from "./motionLibrary.js";
import { createDefaultMotions } from "./defaultMotions.js";
import { AnalyzerLipSync, type LipSyncEngine } from "./lipsync.js";
import { DEFAULT_EXPRESSIONS } from "./expressions.js";
import {
  neutralParams,
  type AvatarParams,
  type AvatarProvider,
  type AvatarState,
  type CharacterDefinition,
  type Emotion,
  type Gesture,
  type GazeTarget,
  type MotionCategory,
} from "./types.js";

export interface MotionStackAvatarOptions {
  library?: MotionLibrary;
  lipSync?: LipSyncEngine;
  clock?: () => number;
  /** "raf" (browser), "interval" (node/test), or "manual" (call tick() yourself). */
  scheduler?: "raf" | "interval" | "manual";
  rng?: () => number;
}

const GESTURE_CLIPS: Record<Gesture, { clipId?: string; category: MotionCategory; tags?: string[] }> = {
  nod_small: { clipId: "nod_small", category: "reaction" },
  nod_normal: { clipId: "nod_normal", category: "reaction" },
  nod_strong: { clipId: "nod_strong", category: "reaction" },
  head_tilt: { clipId: "head_tilt", category: "reaction" },
  head_shake: { clipId: "head_shake", category: "reaction" },
  eyebrow_raise: { clipId: "eyebrow_raise", category: "reaction" },
  surprised: { clipId: "surprised", category: "reaction" },
  happy: { clipId: "happy", category: "reaction" },
  laugh_soft: { clipId: "laugh_soft", category: "reaction" },
  concerned: { clipId: "concerned", category: "reaction" },
  thinking: { clipId: "thinking", category: "reaction" },
  encourage: { clipId: "encourage", category: "reaction" },
  greeting: { clipId: "greeting", category: "social" },
  bow: { clipId: "bow", category: "social" },
  goodbye: { clipId: "goodbye", category: "social" },
  celebrate: { clipId: "celebrate", category: "social" },
  wave: { clipId: "goodbye", category: "social" },
  point: { clipId: "teach_point", category: "teaching" },
  shrug: { category: "reaction", tags: ["tilt"] },
};

const STATE_LAYER: Partial<Record<MotionCategory, MotionLayer>> = {
  idle: "idle",
  listening: "idle",
  thinking: "idle",
  speaking: "speech",
  reaction: "gesture",
  social: "gesture",
  teaching: "gesture",
  greeting: "gesture",
};

/**
 * Shared AvatarProvider implementation for renderers driven by canonical parameters
 * (Live2D, VRM, canvas). Subclasses only load a model and apply AvatarParams.
 * Cloud "realistic" providers do NOT use this (spec §17).
 */
export abstract class MotionStackAvatarBase implements AvatarProvider {
  abstract readonly id: string;
  readonly stack: MotionStack;
  readonly library: MotionLibrary;
  lipSync: LipSyncEngine;
  protected character: CharacterDefinition | null = null;
  protected state: AvatarState = "IDLE";
  protected clock: () => number;
  private rng: () => number;
  private scheduler: "raf" | "interval" | "manual";
  private timer: ReturnType<typeof setInterval> | number | null = null;
  private running = false;
  private lastTick = 0;
  private gaze: GazeTarget = { kind: "user" };
  private gazeCurrent = { x: 0, y: 0 };
  private blinkStart = -1;
  private blinkDuration = 150;
  private micro: Partial<AvatarParams> = {};
  private lastParams: AvatarParams = neutralParams();

  constructor(opts: MotionStackAvatarOptions = {}) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.stack = new MotionStack(this.clock);
    this.library = opts.library ?? new MotionLibrary().registerAll(createDefaultMotions());
    this.lipSync = opts.lipSync ?? new AnalyzerLipSync();
    this.rng = opts.rng ?? Math.random;
    this.scheduler = opts.scheduler ?? (typeof requestAnimationFrame === "function" ? "raf" : "interval");
  }

  // ---- renderer hooks ----------------------------------------------------
  protected abstract loadModel(character: CharacterDefinition): Promise<void>;
  protected abstract applyParams(params: AvatarParams, dtMs: number): void;
  protected abstract disposeModel(): Promise<void>;

  // ---- AvatarProvider ----------------------------------------------------
  async prepare(character: CharacterDefinition): Promise<void> {
    this.character = character;
    await this.loadModel(character);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.lastTick = this.clock();
    this.setState("IDLE", true);
    this.startLoop();
  }

  pushAudio(frame: PCMFrame): void {
    // Generation guard: audio that arrives while the avatar is not speaking (late chunk after an
    // interruption, or tail of a finished turn) must not prime the analyser — otherwise the next
    // SPEAKING frame would open the mouth from stale energy.
    if (!this.stack.isSpeaking) return;
    this.lipSync.push(frame);
  }

  setState(state: AvatarState, force = false): void {
    if (!force && state === this.state) return;
    const prev = this.state;
    this.state = state;
    switch (state) {
      case "IDLE":
        this.stack.setSpeaking(false);
        this.stack.clear("speech");
        this.playCategory("idle");
        this.setGaze({ kind: "user" });
        break;
      case "LISTENING":
        this.stack.setSpeaking(false);
        this.stack.clear("speech");
        this.playCategory("listening", { energy: 0.3 });
        this.setGaze({ kind: "user" });
        break;
      case "THINKING":
        this.stack.setSpeaking(false);
        this.stack.clear("speech");
        this.playCategory("thinking");
        this.setGaze({ kind: "up", x: 0.3 * (this.rng() < 0.5 ? -1 : 1), y: 0.4 });
        break;
      case "SPEAKING":
        if (prev !== "SPEAKING") {
          this.playCategory("speaking");
          this.playCategory("idle");
        }
        this.setGaze({ kind: "user" });
        this.stack.setSpeaking(true);
        break;
      case "INTERRUPTED":
        this.interrupt();
        break;
      case "REACTING":
        break;
    }
  }

  setEmotion(emotion: Emotion, intensity: number): void {
    const custom = this.character?.expressions?.[emotion];
    const params = typeof custom === "object" ? custom : DEFAULT_EXPRESSIONS[emotion];
    this.stack.setAbsolute("emotion", emotion === "neutral" ? null : params, Math.max(0, Math.min(1, intensity)));
    if (typeof custom === "string") this.applyFileExpression(emotion, custom, intensity);
  }

  /** Renderers with native expression files (Live2D exp3) may override. */
  protected applyFileExpression(_emotion: Emotion, _file: string, _intensity: number): void {}

  performGesture(gesture: Gesture, intensity: number): void {
    const spec = GESTURE_CLIPS[gesture];
    let clip: MotionClip | null = null;
    if (spec.clipId && this.library.has(spec.clipId)) {
      clip = this.library.get(spec.clipId)!;
      this.library.notePlayed(clip.id);
    } else {
      clip = this.library.pick(spec.category, { tags: spec.tags, rng: this.rng, energy: intensity });
    }
    if (!clip) return;
    this.stack.play("gesture", clip, { scale: 0.45 + 0.55 * Math.max(0, Math.min(1, intensity)) });
  }

  setGaze(target: GazeTarget): void {
    this.gaze = target;
  }

  /** Hard stop of mouth + speech/gesture motion. Applies a frame immediately (≤ 1 tick). */
  interrupt(): void {
    this.stack.setSpeaking(false);
    this.stack.cut("speech");
    this.stack.cut("gesture");
    this.lipSync.reset();
    this.stack.setLipSync({ mouthOpenY: 0, mouthForm: 0 });
    const now = this.clock();
    this.lastParams = this.stack.compose(now, 16);
    this.applyParams(this.lastParams, 16);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.stopLoop();
    await this.disposeModel();
  }

  getParams(): AvatarParams {
    return { ...this.lastParams };
  }

  // ---- Behavior Engine surface --------------------------------------------
  blink(durationMs = 150): void {
    if (this.blinkStart >= 0) return;
    this.blinkStart = this.clock();
    this.blinkDuration = durationMs;
  }

  setMicroMotion(params: Partial<AvatarParams>): void {
    this.micro = params;
  }

  playMotion(category: MotionCategory, opts: { tags?: string[]; energy?: number; clipId?: string } = {}): void {
    this.playCategory(category, opts);
  }

  get currentState(): AvatarState {
    return this.state;
  }

  // ---- loop ------------------------------------------------------------------
  /** Compose + apply one frame. Public so tests / manual schedulers can drive it. */
  tick(now: number = this.clock()): AvatarParams {
    const dt = Math.max(1, Math.min(100, now - this.lastTick));
    this.lastTick = now;

    if (this.stack.isSpeaking) {
      const ls = this.lipSync.sample();
      this.stack.setLipSync({ mouthOpenY: ls.mouthOpenY, mouthForm: ls.mouthForm });
    }

    // Gaze: eyes lead, head follows a fraction.
    const target = gazeVector(this.gaze);
    const k = 1 - Math.exp(-dt / 120);
    this.gazeCurrent.x += (target.x - this.gazeCurrent.x) * k;
    this.gazeCurrent.y += (target.y - this.gazeCurrent.y) * k;
    this.stack.setProcedural("gaze", {
      eyeBallX: this.gazeCurrent.x,
      eyeBallY: this.gazeCurrent.y,
      angleX: this.gazeCurrent.x * 6,
      angleY: this.gazeCurrent.y * 4,
    });

    // Blink curve (fast close, slower open) + micro motion.
    let eye = 1;
    if (this.blinkStart >= 0) {
      const x = (now - this.blinkStart) / this.blinkDuration;
      if (x >= 1) this.blinkStart = -1;
      else eye = x < 0.35 ? 1 - x / 0.35 : (x - 0.35) / 0.65;
      eye = Math.max(0, Math.min(1, eye));
    }
    this.stack.setProcedural("faceMicro", { ...this.micro, eyeLOpen: eye * (this.micro.eyeLOpen ?? 1), eyeROpen: eye * (this.micro.eyeROpen ?? 1) });

    this.lastParams = this.stack.compose(now, dt);
    this.applyParams(this.lastParams, dt);
    return this.lastParams;
  }

  private playCategory(category: MotionCategory, opts: { tags?: string[]; energy?: number; clipId?: string } = {}): void {
    const allowed = this.character?.motions?.[category];
    let clip: MotionClip | null = null;
    if (opts.clipId && this.library.has(opts.clipId)) {
      clip = this.library.get(opts.clipId)!;
      this.library.notePlayed(clip.id);
    } else {
      const exclude = allowed?.length ? this.library.byCategory(category).map((c) => c.id).filter((id) => !allowed.includes(id)) : undefined;
      clip = this.library.pick(category, { tags: opts.tags, energy: opts.energy, rng: this.rng, exclude });
    }
    if (!clip) return;
    const layer = STATE_LAYER[category] ?? "gesture";
    this.stack.play(layer, clip);
  }

  private startLoop(): void {
    if (this.scheduler === "manual") return;
    if (this.scheduler === "raf") {
      const loop = () => {
        if (!this.running) return;
        this.tick();
        this.timer = requestAnimationFrame(loop);
      };
      this.timer = requestAnimationFrame(loop);
    } else {
      this.timer = setInterval(() => this.tick(), 33);
    }
  }

  private stopLoop(): void {
    if (this.timer === null) return;
    if (this.scheduler === "raf") cancelAnimationFrame(this.timer as number);
    else clearInterval(this.timer as ReturnType<typeof setInterval>);
    this.timer = null;
  }
}

function gazeVector(t: GazeTarget): { x: number; y: number } {
  switch (t.kind) {
    case "user":
      return { x: 0, y: 0 };
    case "away":
      return { x: t.x ?? 0.4, y: t.y ?? 0 };
    case "down":
      return { x: t.x ?? 0, y: t.y ?? -0.5 };
    case "up":
      return { x: t.x ?? 0.2, y: t.y ?? 0.5 };
    case "point":
      return { x: t.x ?? 0, y: t.y ?? 0 };
  }
}
