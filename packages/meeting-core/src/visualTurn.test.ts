import { describe, expect, it } from "vitest";
import { ParticipationPolicy } from "./participationPolicy.js";
import { emptyCue, type VisualCue } from "@rcai/visual-core";

/**
 * A nod is an answer. After 「Attendee に切り替えた方がいいです」 the reply is often a nod, and a
 * character that waits for words is talking into a pause that was never empty.
 */
const A = { participantId: "p_a", speakerName: "Aさん" };
const cue = (over: Partial<VisualCue>): VisualCue => ({ ...emptyCue("p_a", 0), facePresent: true, confidence: 1, ...over });

function engaged(now = 1000) {
  const p = new ParticipationPolicy({ names: ["ゆい"], cooldownMs: 0, maxConsecutiveResponses: 99 });
  p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, now);
  p.markResponding(now);
  p.onAssistantDone(now + 500);
  return p;
}

describe("visual reactions as turns", () => {
  it("a nod from the person being talked with earns a turn", () => {
    const p = engaged();
    expect(p.onVisualCue(cue({ nodded: true }), 3000)).toBe(true);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("visual: nodded");
  });

  it("a head shake earns a turn too — it is a different answer, not silence", () => {
    const p = engaged();
    expect(p.onVisualCue(cue({ shookHead: true }), 3000)).toBe(true);
  });

  it("a nod from someone the character is not talking with earns nothing", () => {
    const p = engaged();
    expect(p.onVisualCue({ ...cue({ nodded: true }), participantId: "p_b" }, 3000)).toBe(false);
    expect(p.state).not.toBe("ADDRESSED");
  });

  it("earns nothing when nobody is in a conversation with the character", () => {
    const p = new ParticipationPolicy({ names: ["ゆい"] });
    expect(p.onVisualCue(cue({ nodded: true }), 3000)).toBe(false);
  });

  it("a low-confidence or absent face is not a reaction", () => {
    const p = engaged();
    expect(p.onVisualCue(cue({ nodded: true, confidence: 0.3 }), 3000)).toBe(false);
    expect(p.onVisualCue(cue({ nodded: true, facePresent: false }), 3000)).toBe(false);
  });

  it("a smile is not a turn: it is context, not an answer", () => {
    const p = engaged();
    expect(p.onVisualCue(cue({ smile: 0.9 }), 3000)).toBe(false);
  });

  it("does not interrupt the character's own answer", () => {
    const p = engaged();
    p.onTranscript({ ...A, text: "なんで？", final: true }, 3000);
    p.markResponding(3000);
    expect(p.onVisualCue(cue({ nodded: true }), 3200)).toBe(false);
  });

  it("can be switched off", () => {
    const p = new ParticipationPolicy({ names: ["ゆい"], cooldownMs: 0, visualTurns: false });
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, 1000);
    p.markResponding(1000);
    p.onAssistantDone(1500);
    expect(p.onVisualCue(cue({ nodded: true }), 3000)).toBe(false);
  });
});
