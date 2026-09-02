import { describe, expect, it } from "vitest";
import { ParticipationPolicy } from "./participationPolicy.js";
import { emptyCue } from "@rcai/visual-core";

/**
 * The four states exist so the character can tell "I was cut off" from "nobody is talking to me".
 * Without that difference it either restarts the conversation from scratch or keeps talking over the
 * person who cut in.
 */
const A = { participantId: "p_a", speakerName: "Aさん" };

function engaged(now = 1000) {
  const p = new ParticipationPolicy({ names: ["ゆい"], cooldownMs: 4000, yieldGraceMs: 700 });
  p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, now);
  return p;
}

describe("engagement states", () => {
  it("passive until someone calls the character", () => {
    const p = new ParticipationPolicy({ names: ["ゆい"] });
    expect(p.engagementState).toBe("PASSIVE");
  });

  it("yields the floor while a person is speaking, and takes it back after", () => {
    const p = engaged();
    p.onSpeechActivity(true, 2000, "Aさん");
    expect(p.engagementState).toBe("YIELDING");
    p.tick(2500); // still inside the grace after they stopped
    expect(p.engagementState).toBe("YIELDING");
    p.tick(3000);
    expect(p.engagementState).toBe("ENGAGED");
  });

  it("being cut off leaves the conversation open and the floor with the person", () => {
    const p = engaged();
    p.markResponding(1500);
    p.onInterrupted(2000);
    expect(p.state).toBe("OBSERVING");
    expect(p.engagementState).toBe("YIELDING");
    expect(p.engagedWith).not.toBeNull(); // still in the conversation
  });

  it("an interruption does not count as a turn the character took", () => {
    const p = new ParticipationPolicy({ names: ["ゆい"], cooldownMs: 0, maxConsecutiveResponses: 1 });
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, 1000);
    p.markResponding(1000);
    p.onInterrupted(1200);
    p.tick(3000);
    // The cap would have blocked this if being cut off had counted.
    p.onTranscript({ ...A, text: "もう一度お願い", final: true }, 3000);
    expect(p.state).toBe("ADDRESSED");
  });

  it("cools down after answering, then is engaged again", () => {
    const p = engaged();
    p.markResponding(1500);
    p.onAssistantDone(2000);
    p.tick(3000);
    expect(p.engagementState).toBe("COOLDOWN");
    p.tick(6500);
    expect(p.engagementState).toBe("ENGAGED");
  });

  it("a nod while someone is speaking is not an interruption", () => {
    const p = engaged();
    p.markResponding(1200);
    p.onAssistantDone(1300);
    p.onSpeechActivity(true, 6000, "Aさん");
    const cue = { ...emptyCue("p_a", 6100), facePresent: true, confidence: 1, nodded: true };
    expect(p.onVisualCue(cue, 6100)).toBe(false);
  });
});
