import { describe, expect, it } from "vitest";
import { Ema, GestureDetector, VisualPerception, anglesFromMatrix } from "./index.js";

/** 2 fps, because that is what Attendee's 360p webcam stream delivers. */
const FRAME_MS = 500;

function pitchMatrix(pitch: number): number[] {
  // Row-major 4x4 with only the X rotation set — enough for the extraction under test.
  const c = Math.cos(pitch), s = Math.sin(pitch);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1];
}

describe("head angles", () => {
  it("reads pitch back out of a rotation matrix", () => {
    const a = anglesFromMatrix(pitchMatrix(0.3));
    expect(a.pitch).toBeCloseTo(-0.3, 2);
    expect(a.yaw).toBeCloseTo(0, 5);
  });
  it("survives a degenerate matrix instead of returning NaN", () => {
    const a = anglesFromMatrix([2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(Number.isFinite(a.pitch)).toBe(true);
  });
});

describe("smoothing", () => {
  it("does not let one noisy frame become the value", () => {
    const e = new Ema(0.35);
    e.push(0); e.push(0);
    const after = e.push(1); // a single bad frame
    expect(after).toBeLessThan(0.4);
  });
});

describe("nod detection", () => {
  it("fires on down-and-back, at 2 fps", () => {
    const d = new GestureDetector();
    let t = 0;
    const seq = [0, 0.2, 0.25, 0.02];
    let fired = false;
    for (const v of seq) { fired = d.push(v, t) || fired; t += FRAME_MS; }
    expect(fired).toBe(true);
  });

  it("does not fire when the head is simply held down (reading, typing)", () => {
    const d = new GestureDetector();
    let t = 0, fired = false;
    for (const v of [0, 0.22, 0.24, 0.23, 0.25, 0.24]) { fired = d.push(v, t) || fired; t += FRAME_MS; }
    expect(fired).toBe(false);
  });

  it("does not fire on small movement", () => {
    const d = new GestureDetector();
    let t = 0, fired = false;
    for (const v of [0, 0.05, 0.06, 0.01]) { fired = d.push(v, t) || fired; t += FRAME_MS; }
    expect(fired).toBe(false);
  });

  it("counts one nod once, not on every following frame", () => {
    const d = new GestureDetector();
    let t = 0, count = 0;
    for (const v of [0, 0.2, 0.25, 0.02, 0.01, 0.0, 0.01]) { if (d.push(v, t)) count++; t += FRAME_MS; }
    expect(count).toBe(1);
  });
});

describe("perception", () => {
  const blend = (smile = 0) => ({ mouthSmileLeft: smile, mouthSmileRight: smile, eyeBlinkLeft: 0, eyeBlinkRight: 0, browInnerUp: 0 });

  it("tracks participants separately", () => {
    const p = new VisualPerception();
    p.observe({ participantId: "a", at: 0, blendshapes: blend(0.9), matrix: pitchMatrix(0) });
    p.observe({ participantId: "b", at: 0, blendshapes: blend(0), matrix: pitchMatrix(0) });
    expect(p.cue("a", 100).smile).toBeGreaterThan(p.cue("b", 100).smile);
  });

  it("reports a nod for the participant who nodded", () => {
    const p = new VisualPerception();
    let t = 0;
    let nodded = false;
    for (const v of [0, 0.2, 0.25, 0.02]) {
      nodded = p.observe({ participantId: "a", at: t, blendshapes: blend(), matrix: pitchMatrix(v) }).nodded || nodded;
      t += FRAME_MS;
    }
    expect(nodded).toBe(true);
  });

  it("a camera that goes dark reads as absent, not as a neutral face", () => {
    const p = new VisualPerception({ absentAfterMs: 4000 });
    p.observe({ participantId: "a", at: 1000, blendshapes: blend(0.8), matrix: pitchMatrix(0) });
    expect(p.cue("a", 1500).facePresent).toBe(true);
    expect(p.cue("a", 9000).facePresent).toBe(false);
    expect(p.cue("a", 9000).confidence).toBe(0);
  });

  it("the first frames are marked low confidence rather than trusted", () => {
    const p = new VisualPerception();
    const first = p.observe({ participantId: "a", at: 0, blendshapes: blend(0.5), matrix: pitchMatrix(0) });
    expect(first.confidence).toBeLessThan(1);
  });
});
