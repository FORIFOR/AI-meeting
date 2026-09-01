import { Ema, emptyCue, type VisualCue } from "./cue.js";
import { GestureDetector } from "./gesture.js";

/**
 * The measurements a face model produces, in the shape this package needs — so the model itself stays
 * outside. MediaPipe's Face Landmarker gives 52 blendshape coefficients and a 4x4 transformation
 * matrix; another model would give something else. Only these fields cross the boundary.
 */
export interface FaceObservation {
  participantId: string;
  at: number;
  /** Blendshape coefficients by name, 0..1 (MediaPipe's `categoryName` → `score`). */
  blendshapes: Record<string, number>;
  /** Row-major 4x4 facial transformation matrix, if the model produced one. */
  matrix?: number[];
}

/** Head angles in radians from a row-major 4x4 facial transformation matrix. */
export function anglesFromMatrix(m: number[]): { yaw: number; pitch: number; roll: number } {
  if (m.length < 11) return { yaw: 0, pitch: 0, roll: 0 };
  // Standard ZYX extraction from the rotation part. Clamped because a denormalised matrix would
  // otherwise produce NaN from asin and poison every average downstream.
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  const pitch = Math.asin(clamp(-m[9]!));
  const yaw = Math.atan2(m[8]!, m[10]!);
  const roll = Math.atan2(m[1]!, m[5]!);
  return { yaw, pitch, roll };
}

const mean = (...xs: (number | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

/**
 * Turns a stream of face observations into cues, one track per participant.
 *
 * Everything is smoothed and every gesture is a shape over time, so a single frame can neither make
 * the character react nor make it think a person left the room.
 */
export class VisualPerception {
  private tracks = new Map<string, Track>();
  constructor(private readonly opts: { absentAfterMs?: number } = {}) {}

  observe(o: FaceObservation): VisualCue {
    let t = this.tracks.get(o.participantId);
    if (!t) {
      t = new Track();
      this.tracks.set(o.participantId, t);
    }
    return t.push(o);
  }

  /** No frame for a while means the camera is off or the person left — not that they stopped smiling. */
  absent(participantId: string, now: number): VisualCue {
    const t = this.tracks.get(participantId);
    if (t) t.reset();
    return emptyCue(participantId, now);
  }

  cue(participantId: string, now: number): VisualCue {
    const t = this.tracks.get(participantId);
    if (!t) return emptyCue(participantId, now);
    if (now - t.lastAt > (this.opts.absentAfterMs ?? 4000)) return emptyCue(participantId, now);
    return { ...t.last, at: now, nodded: false, shookHead: false, tilted: false };
  }

  forget(participantId: string): void {
    this.tracks.delete(participantId);
  }
}

class Track {
  private smile = new Ema();
  private brow = new Ema();
  private blink = new Ema();
  private yaw = new Ema(0.5);
  private pitch = new Ema(0.5);
  private roll = new Ema(0.5);
  private nod = new GestureDetector();
  private shake = new GestureDetector({ amplitude: 0.16 });
  private frames = 0;
  lastAt = -Infinity;
  last: VisualCue = emptyCue("", 0);

  push(o: FaceObservation): VisualCue {
    const b = o.blendshapes;
    const smile = this.smile.push(mean(b.mouthSmileLeft, b.mouthSmileRight));
    const brow = this.brow.push(mean(b.browInnerUp, b.browOuterUpLeft, b.browOuterUpRight));
    const blink = this.blink.push(mean(b.eyeBlinkLeft, b.eyeBlinkRight));
    const a = o.matrix ? anglesFromMatrix(o.matrix) : { yaw: 0, pitch: 0, roll: 0 };
    const yaw = this.yaw.push(a.yaw);
    const pitch = this.pitch.push(a.pitch);
    const roll = this.roll.push(a.roll);
    // Gestures run on the raw angles: smoothing is what would erase an out-and-back at 2 fps.
    const nodded = this.nod.push(a.pitch, o.at);
    const shookHead = this.shake.push(a.yaw, o.at);
    this.frames++;
    const cue: VisualCue = {
      participantId: o.participantId,
      at: o.at,
      facePresent: true,
      smile,
      browRaise: brow,
      blink,
      headYaw: yaw,
      headPitch: pitch,
      headRoll: roll,
      nodded,
      shookHead,
      tilted: Math.abs(roll) > 0.26, // ~15°, held rather than a gesture
      lookingForward: Math.max(0, 1 - (Math.abs(yaw) + Math.abs(pitch)) / 0.9),
      // The first frames are mostly the EMA's own start-up, not measurement.
      confidence: Math.min(1, this.frames / 3),
    };
    this.last = cue;
    this.lastAt = o.at;
    return cue;
  }

  reset(): void {
    this.smile.reset();
    this.brow.reset();
    this.blink.reset();
    this.yaw.reset();
    this.pitch.reset();
    this.roll.reset();
    this.nod.reset();
    this.shake.reset();
    this.frames = 0;
    this.lastAt = -Infinity;
  }
}
