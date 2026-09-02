import type { PCMFrame } from "@rcai/audio-core";

/** Spec §10 */
export type AvatarState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "INTERRUPTED" | "REACTING";

export type Emotion =
  | "neutral"
  | "smile"
  | "laugh"
  | "serious"
  | "sad"
  | "thinking"
  | "surprised"
  | "warm_positive"
  | "concerned"
  | "encourage";

export type Gesture =
  | "nod_small"
  | "nod_normal"
  | "nod_strong"
  | "head_tilt"
  | "head_shake"
  | "eyebrow_raise"
  | "surprised"
  | "happy"
  | "laugh_soft"
  | "concerned"
  | "thinking"
  | "encourage"
  | "greeting"
  | "bow"
  | "goodbye"
  | "celebrate"
  | "wave"
  | "point"
  | "shrug";

export interface GazeTarget {
  /** user = camera/screen center; away = short saccade; down/up = thinking looks. */
  kind: "user" | "away" | "down" | "up" | "point";
  /** Normalized offset (-1..1) used by away/point. */
  x?: number;
  y?: number;
}

/** Spec §8 */
export interface AvatarProvider {
  readonly id: "live2d" | "vrm" | "liveavatar" | "tavus" | "canvas" | string;
  prepare(character: CharacterDefinition): Promise<void>;
  start(): Promise<void>;
  /** The PCM actually being played (from SpeakerOutput.tap) — the lip sync source of truth. */
  pushAudio(frame: PCMFrame): void;
  setState(state: AvatarState): void;
  setEmotion(emotion: Emotion, intensity: number): void;
  performGesture(gesture: Gesture, intensity: number): void;
  setGaze(target: GazeTarget): void;
  /** Close the mouth and stop speaking motion immediately. */
  interrupt(): void;
  stop(): Promise<void>;
  /** Optional: the last composed parameter set (for tests / debug overlays). */
  getParams?(): AvatarParams;
  // ---- Optional micro-motion surface used by the Behavior Engine (spec §13). Cloud avatars omit these.
  /** Trigger one blink (close+open) lasting `durationMs`. */
  blink?(durationMs?: number): void;
  /** Additive procedural offsets (breathing, sway, micro brow). Replaced each call. */
  setMicroMotion?(params: Partial<AvatarParams>): void;
  /** Re-pick a clip from the library for a category (variation while listening/speaking). */
  playMotion?(category: MotionCategory, opts?: { tags?: string[]; energy?: number; clipId?: string }): void;
}

/** Renderer-agnostic parameter set (Live2D standard ids map 1:1; VRM maps to bones/expressions). */
export interface AvatarParams {
  angleX: number; // -30..30 deg
  angleY: number;
  angleZ: number;
  bodyAngleX: number; // -10..10
  bodyAngleY: number;
  bodyAngleZ: number;
  eyeLOpen: number; // 0..1(+)
  eyeROpen: number;
  eyeLSmile: number; // 0..1
  eyeRSmile: number;
  eyeBallX: number; // -1..1
  eyeBallY: number;
  browLY: number; // -1..1
  browRY: number;
  browLForm: number; // -1..1
  browRForm: number;
  mouthOpenY: number; // 0..1
  mouthForm: number; // -1..1
  cheek: number; // 0..1
  breath: number; // 0..1
  shoulder: number; // -1..1
  armL: number; // -1..1
  armR: number;
  handL: number;
  handR: number;
}

export type ParamName = keyof AvatarParams;

export const PARAM_NAMES: ParamName[] = [
  "angleX", "angleY", "angleZ", "bodyAngleX", "bodyAngleY", "bodyAngleZ",
  "eyeLOpen", "eyeROpen", "eyeLSmile", "eyeRSmile", "eyeBallX", "eyeBallY",
  "browLY", "browRY", "browLForm", "browRForm", "mouthOpenY", "mouthForm",
  "cheek", "breath", "shoulder", "armL", "armR", "handL", "handR",
];

export function neutralParams(): AvatarParams {
  return {
    angleX: 0, angleY: 0, angleZ: 0, bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0,
    eyeLOpen: 1, eyeROpen: 1, eyeLSmile: 0, eyeRSmile: 0, eyeBallX: 0, eyeBallY: 0,
    browLY: 0, browRY: 0, browLForm: 0, browRForm: 0, mouthOpenY: 0, mouthForm: 0,
    cheek: 0, breath: 0, shoulder: 0, armL: 0, armR: 0, handL: 0, handR: 0,
  };
}

/** Live2D standard parameter ids for the canonical set (spec §9 character packs). */
export const LIVE2D_PARAM_IDS: Record<ParamName, string> = {
  angleX: "ParamAngleX", angleY: "ParamAngleY", angleZ: "ParamAngleZ",
  bodyAngleX: "ParamBodyAngleX", bodyAngleY: "ParamBodyAngleY", bodyAngleZ: "ParamBodyAngleZ",
  eyeLOpen: "ParamEyeLOpen", eyeROpen: "ParamEyeROpen", eyeLSmile: "ParamEyeLSmile", eyeRSmile: "ParamEyeRSmile",
  eyeBallX: "ParamEyeBallX", eyeBallY: "ParamEyeBallY",
  browLY: "ParamBrowLY", browRY: "ParamBrowRY", browLForm: "ParamBrowLForm", browRForm: "ParamBrowRForm",
  mouthOpenY: "ParamMouthOpenY", mouthForm: "ParamMouthForm", cheek: "ParamCheek", breath: "ParamBreath",
  shoulder: "ParamShoulder", armL: "ParamArmLA", armR: "ParamArmRA", handL: "ParamHandL", handR: "ParamHandR",
};

/** Ranges used when mapping canonical values to a renderer. */
export const PARAM_RANGES: Record<ParamName, [number, number]> = {
  angleX: [-30, 30], angleY: [-30, 30], angleZ: [-30, 30],
  bodyAngleX: [-10, 10], bodyAngleY: [-10, 10], bodyAngleZ: [-10, 10],
  eyeLOpen: [0, 1.5], eyeROpen: [0, 1.5], eyeLSmile: [0, 1], eyeRSmile: [0, 1],
  eyeBallX: [-1, 1], eyeBallY: [-1, 1],
  browLY: [-1, 1], browRY: [-1, 1], browLForm: [-1, 1], browRForm: [-1, 1],
  mouthOpenY: [0, 1], mouthForm: [-1, 1], cheek: [0, 1], breath: [0, 1],
  shoulder: [-1, 1], armL: [-1, 1], armR: [-1, 1], handL: [-1, 1], handR: [-1, 1],
};

export function clampParams(p: AvatarParams): AvatarParams {
  const out = { ...p };
  for (const k of PARAM_NAMES) {
    const [lo, hi] = PARAM_RANGES[k];
    out[k] = Math.min(hi, Math.max(lo, out[k]));
  }
  return out;
}

// ---- Character pack (spec §9, §24) --------------------------------------

export interface VoiceProfile {
  characterId: string;
  voices: Partial<Record<"openai" | "google" | "local", string>>;
  /** Style hints preserved across providers (spec §24). */
  style?: { speed?: number; energy?: number; pitch?: "low" | "mid" | "high"; politeness?: "casual" | "polite" | "formal" };
}

export interface CharacterManifest {
  id: string;
  name: string;
  renderer: "live2d" | "vrm" | "liveavatar" | "tavus" | "canvas";
  defaultPersona: string;
  supportedLanguages: string[];
  motionProfile: string;
  voiceProfiles: string[];
  license?: string;
}

export interface CharacterDefinition {
  manifest: CharacterManifest;
  /** Base URL/path of the character pack directory. */
  baseUrl: string;
  /** Renderer model entry: `model/yui.model3.json`, `model/yui.vrm`, or a cloud avatar id. */
  model: string;
  /** Emotion → expression file (exp3.json) or inline canonical param targets. */
  expressions: Partial<Record<Emotion, string | Partial<AvatarParams>>>;
  /** Motion clip ids per category available for this character (from the shared library or pack JSON). */
  motions: Partial<Record<MotionCategory, string[]>>;
  /** Extra clip JSON files bundled with the pack (`motions/<category>/<id>.json`). */
  motionFiles?: string[];
  voice: VoiceProfile;
  /**
   * Renderer hints. `meeting` is the video-tile framing — head and shoulders filling the frame — used
   * when the renderer is asked for it (a meeting vendor captures the page at 1280x720, encodes it twice
   * and the room sees a tile a few hundred pixels wide; a full-figure portrait does not survive that).
   */
  view?: { scale?: number; x?: number; y?: number; background?: string; meeting?: { scale?: number; x?: number; y?: number } };
  /** Renderer-specific parameter id overrides (e.g. custom Live2D ids). */
  paramIds?: Partial<Record<ParamName, string>>;
}

export type MotionCategory = "idle" | "listening" | "speaking" | "thinking" | "reaction" | "social" | "teaching" | "greeting";
