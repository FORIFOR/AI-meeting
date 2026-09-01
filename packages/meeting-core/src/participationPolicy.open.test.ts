import { describe, expect, it } from "vitest";
import { ParticipationPolicy } from "./participationPolicy.js";

/**
 * "open": the character joins a conversation it was not called into. The point of the tier is that it
 * still takes a turn rather than talking over one — the cooldown, the consecutive cap and the wait for
 * silence all still apply, they are just no longer gated on hearing its own name.
 */
const make = () => new ParticipationPolicy({ names: ["Yui", "ゆい"], proactivity: "open", cooldownMs: 4000, activeSilenceMs: 1800 });

describe("open participation", () => {
  it("speaks after ordinary conversation, without its name", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true }, t);
    expect(p.state).toBe("LISTENING"); // not immediately — someone may still be talking
    t += 2600; // room goes quiet past silenceGapMs and activeSilenceMs
    p.tick(t);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toMatch(/open/);
  });

  it("does not take a turn on a backchannel", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ text: "うん", final: true }, t);
    t += 3000;
    p.tick(t);
    expect(p.state).toBe("OBSERVING");
  });

  it("keeps the cooldown: it does not answer itself twice in a row immediately", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ text: "そういえば新しい店ができたらしいよ", final: true }, t);
    t += 2600; p.tick(t);
    expect(p.state).toBe("ADDRESSED");
    p.markResponding(t);
    p.onAssistantDone(t + 1000);
    // Straight back into conversation, inside the 4 s cooldown.
    p.onTranscript({ text: "駅前のところですよね", final: true }, t + 1500);
    p.tick(t + 4200);
    expect(p.state).toBe("OBSERVING");
  });

  it("addressed_only is unchanged: ordinary conversation earns nothing", () => {
    const p = new ParticipationPolicy({ names: ["Yui", "ゆい"] });
    let t = 1000;
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true }, t);
    t += 3000; p.tick(t);
    expect(p.state).toBe("OBSERVING");
  });
});
