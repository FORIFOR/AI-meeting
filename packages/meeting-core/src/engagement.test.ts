import { describe, expect, it } from "vitest";
import { ParticipationPolicy } from "./participationPolicy.js";

/**
 * Addressing answers "was this turn for me". Engagement answers "am I still in this".
 * Nobody says a person's name in every sentence, and until this layer existed the character
 * required exactly that: 「ゆい、なんで？」「ゆい、例えば？」.
 */
const make = () => new ParticipationPolicy({ names: ["Yui", "ゆい"], engagementTtlMs: 90_000, cooldownMs: 0, maxConsecutiveResponses: 99 });
const A = { participantId: "p_a", speakerName: "Aさん" };
const B = { participantId: "p_b", speakerName: "Bさん" };

/** One full exchange: the character is asked, answers, and the floor returns to the room. */
function exchange(p: ParticipationPolicy, at: number) {
  p.markResponding(at);
  p.onAssistantDone(at + 500);
}

describe("staying in a conversation", () => {
  it("follow-ups need no name once the character has been called", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    expect(p.state).toBe("ADDRESSED");
    expect(p.engagementState).toBe("ENGAGED");
    exchange(p, t);

    for (const line of ["なんで？", "例えば？", "もうちょっと詳しく教えて"]) {
      t += 2000;
      p.onTranscript({ ...A, text: line, final: true }, t);
      expect(p.state, line).toBe("ADDRESSED");
      exchange(p, t);
    }
  });

  it("does not answer for someone else's conversation", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    exchange(p, t);
    t += 2000;
    p.onTranscript({ ...B, text: "さっきの資料どこ？", final: true }, t);
    expect(p.state).not.toBe("ADDRESSED");
  });

  it("lets go when the conversation has moved on", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    exchange(p, t);
    t += 91_000;
    p.tick(t);
    expect(p.engagementState).toBe("PASSIVE");
    p.onTranscript({ ...A, text: "なんで？", final: true }, t);
    expect(p.state).not.toBe("ADDRESSED");
  });

  it("does not take a turn when it is being talked about rather than to", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    exchange(p, t);
    t += 2000;
    p.onTranscript({ ...A, text: "ゆいがさっきそう言ってた", final: true }, t);
    expect(p.state).not.toBe("ADDRESSED");
  });

  it("a backchannel is not a turn", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    exchange(p, t);
    t += 2000;
    p.onTranscript({ ...A, text: "ー", final: true }, t);
    expect(p.state).not.toBe("ADDRESSED");
  });

  it("can be switched off, and then every turn needs the name again", () => {
    const p = new ParticipationPolicy({ names: ["Yui", "ゆい"], engagementTtlMs: 0, cooldownMs: 0 });
    let t = 1000;
    p.onTranscript({ ...A, text: "ゆい、これどう思う？", final: true }, t);
    exchange(p, t);
    expect(p.engagementState).toBe("PASSIVE");
    t += 2000;
    p.onTranscript({ ...A, text: "なんで？", final: true }, t);
    expect(p.state).not.toBe("ADDRESSED");
  });
});
