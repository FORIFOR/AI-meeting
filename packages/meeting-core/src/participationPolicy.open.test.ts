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

/**
 * Arrival. A character let into a room and saying nothing looked wrong to the first person who tried
 * it — 「入室した際に何も挨拶ないのは良くない」 — and addressed_only had no way to speak unasked.
 */
describe("greeting on arrival", () => {
  const quiet = () => new ParticipationPolicy({ names: ["Yui", "ゆい"], proactivity: "addressed_only", cooldownMs: 4000 });

  it("takes one turn on joining, even when it would otherwise only answer", () => {
    const p = quiet();
    expect(p.onJoined(1000)).toBe(true);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("joined the meeting");
  });

  it("is not a response: a name straight after the greeting gets answered, no cooldown", () => {
    const p = quiet();
    p.onJoined(1000);
    p.markResponding(1100);
    p.onAssistantDone(3000);
    expect(p.state).toBe("OBSERVING");
    p.onTranscript({ text: "ゆい、こんにちは", final: true }, 3500); // inside cooldownMs of the greeting's end
    expect(p.state).toBe("ADDRESSED");
  });

  it("does not spend a consecutive turn", () => {
    const p = quiet();
    p.onJoined(1000);
    p.onAssistantDone(2000);
    p.onTranscript({ text: "ゆい、今日の予定は？", final: true }, 10_000);
    p.onAssistantDone(12_000);
    p.onTranscript({ text: "ゆい、もう一つ", final: true }, 20_000); // second answer in a row: still under the cap of 2
    expect(p.state).toBe("ADDRESSED");
  });

  it("arriving mid-speech waits for the silence, then greets", () => {
    const p = quiet();
    p.onSpeechActivity(true, 500);
    expect(p.state).toBe("LISTENING");
    expect(p.onJoined(1000)).toBe(false);
    p.tick(1250);
    expect(p.state).toBe("LISTENING"); // still talking
    p.onSpeechActivity(false, 2000);
    p.tick(4600); // past silenceGapMs → OBSERVING
    p.tick(4850); // next tick: the greeting takes the floor
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("joined the meeting");
  });

  it("a greeting that finds no pause within 30 s is dropped, not delivered into the next question (run 45: 70 s late)", () => {
    const p = quiet();
    p.onSpeechActivity(true, 500);
    expect(p.onJoined(1000)).toBe(false);
    for (let t = 2000; t <= 32_000; t += 1000) {
      p.onSpeechActivity(true, t); // the room keeps talking
      p.tick(t + 100);
    }
    p.onSpeechActivity(false, 33_000);
    p.tick(36_000); // past silenceGapMs → OBSERVING
    p.tick(36_250);
    expect(p.state).toBe("OBSERVING");
    expect(p.addressedBy).toBeNull();
  });

  it("an unsanctioned turn being cut off does not forget the pending greeting", () => {
    const p = quiet();
    p.onSpeechActivity(true, 500);
    p.onJoined(1000);
    p.onInterrupted(1200); // the page killed a generation the policy never sanctioned
    p.onSpeechActivity(false, 1300);
    p.tick(1400);
    expect(p.state).toBe("OBSERVING"); // yield grace: not yet
    p.tick(1200 + 1500 + 250);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("joined the meeting");
  });

  it("a name spoken before the greeting's silence replaces it: no belated greeting afterwards", () => {
    const p = quiet();
    p.onSpeechActivity(true, 500);
    p.onJoined(1000);
    p.onTranscript({ text: "ゆい、聞こえる？", final: true }, 1500);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.text).toBe("ゆい、聞こえる？");
    p.onAssistantDone(4000);
    p.tick(4300);
    expect(p.state).toBe("OBSERVING");
  });

  it("never interrupts: joining a room that is already talking to it is a no-op", () => {
    const p = quiet();
    p.onTranscript({ text: "ゆい、聞こえる？", final: true }, 1000);
    expect(p.state).toBe("ADDRESSED");
    expect(p.onJoined(1100)).toBe(false);
    expect(p.addressedBy?.text).toBe("ゆい、聞こえる？");
  });
});
