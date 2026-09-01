/**
 * Visual cues: what was observed, not what it means.
 *
 * A face is evidence about a conversation's shape — whose turn it is, whether the last answer landed —
 * and it is not evidence about a person's inner state. So nothing here is named "happy" or "bored".
 * The fields are observations a second person in the room could also make: the corners of the mouth
 * moved, the head went down and back up, the eyes are pointed this way. What to do about them is the
 * orchestrator's decision, and what they mean is nobody's.
 */
export interface VisualCue {
  participantId: string;
  at: number;
  facePresent: boolean;
  /** 0..1, smoothed. */
  smile: number;
  browRaise: number;
  blink: number;
  /** Radians. Yaw: turned left/right. Pitch: nodded up/down. Roll: head tilted onto a shoulder. */
  headYaw: number;
  headPitch: number;
  headRoll: number;
  /** A completed gesture, true only on the frame it is recognised. */
  nodded: boolean;
  shookHead: boolean;
  tilted: boolean;
  /** 0..1: how squarely the face is pointed at the camera. */
  lookingForward: number;
  /** 0..1: how much of this cue is measurement rather than carry-over from an older frame. */
  confidence: number;
}

export function emptyCue(participantId: string, at: number): VisualCue {
  return {
    participantId,
    at,
    facePresent: false,
    smile: 0,
    browRaise: 0,
    blink: 0,
    headYaw: 0,
    headPitch: 0,
    headRoll: 0,
    nodded: false,
    shookHead: false,
    tilted: false,
    lookingForward: 0,
    confidence: 0,
  };
}

/**
 * Exponential moving average.
 *
 * Raw per-frame values are unusable: a blendshape coefficient jitters frame to frame, and at 2 fps a
 * single noisy frame is half a second of the character's behaviour. 0.35 puts most of the weight on
 * the last two or three frames — roughly 300–800 ms — which is slow enough to be steady and fast
 * enough that a smile does not arrive after the moment has passed.
 */
export class Ema {
  private value: number | null = null;
  constructor(private readonly alpha = 0.35) {}
  push(x: number): number {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
  get current(): number {
    return this.value ?? 0;
  }
  reset(): void {
    this.value = null;
  }
}
