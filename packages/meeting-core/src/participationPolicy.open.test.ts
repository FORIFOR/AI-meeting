import { MEETING_PERSONA_ID } from "./meetingPrompt.js";
import { describe, expect, it } from "vitest";
import { ParticipationPolicy , defaultProactivityFor} from "./participationPolicy.js";

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

  it("a follow-up that opens with a fragment waits for the second reading (run 109)", () => {
    // 「ゆいが昨日そう言ってたよね」 arrived as 「いいが、昨日そう言ってたよね。」 — the name in a hole — and was
    // answered as a follow-up 1.1 s before the rescore restored the name and the third person.
    const engagedWith = (text: string, at: number) => {
      const p = make();
      p.onTranscript({ text: "そういえば新しい店ができたらしいよ", final: true, participantId: "p1", speakerName: "Aoi" }, at);
      p.tick(at + 2600);
      p.markResponding(at + 2600);
      p.onAssistantDone(at + 3600);
      const t = at + 3600 + 4500;
      p.onTranscript({ text, final: true, participantId: "p1", speakerName: "Aoi" }, t);
      return { p, t };
    };
    // Held: no turn yet …
    const a = engagedWith("いいが、昨日そう言ってたよね。", 1000);
    expect(a.p.state).not.toBe("ADDRESSED");
    a.p.tick(a.t + 1000);
    expect(a.p.state).not.toBe("ADDRESSED");
    // … and the rescore says it was talk about the character: dropped, no turn at all.
    expect(a.p.reviseHeld("いいが、昨日そう言ってたよね。", "ゆいが昨日そう言ってたよね", a.t + 1500)).toBe("dropped");
    a.p.tick(a.t + 5000);
    expect(a.p.state).not.toBe("ADDRESSED");
    // A rescore that is the follow-up it looked like is answered at once, with the better words.
    const b = engagedWith("、来週までに終わりそう？", 1000);
    expect(b.p.state).not.toBe("ADDRESSED");
    expect(b.p.reviseHeld("、来週までに終わりそう？", "それって来週までに終わりそう？", b.t + 1200)).toBe("taken");
    expect(b.p.state).toBe("ADDRESSED");
    expect(b.p.addressedBy?.text).toBe("それって来週までに終わりそう？");
    expect(b.p.getHistory().at(-1)?.reason).toBe("engaged follow-up (rescore)");
    // No second reading in time: answered as heard.
    const c = engagedWith("が昨日そう言ってたよね。", 1000);
    expect(c.p.state).not.toBe("ADDRESSED");
    c.p.tick(c.t + 2600);
    expect(c.p.state).toBe("ADDRESSED");
    expect(c.p.getHistory().at(-1)?.reason).toBe("engaged follow-up (held)");
    // A whole sentence is answered straight away, as before.
    const d = engagedWith("駅前のところ、行ってみたいんだよね", 1000);
    expect(d.p.state).toBe("ADDRESSED");
    expect(d.p.reviseHeld("駅前のところ、行ってみたいんだよね", "駅前のところ、行ってみたいんだよね", d.t + 1000)).toBeNull();
  });

  it("the person it answered keeps its attention: their next line is a follow-up, no wait for silence", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ text: "そういえば新しい店ができたらしいよ", final: true, participantId: "p1", speakerName: "Aoi" }, t);
    t += 2600; p.tick(t);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.speakerName).toBe("Aoi");
    p.markResponding(t);
    p.onAssistantDone(t + 1000);
    t += 1000 + 4500; // past the cooldown
    p.onTranscript({ text: "駅前のところ、行ってみたいんだよね", final: true, participantId: "p1", speakerName: "Aoi" }, t);
    expect(p.state).toBe("ADDRESSED"); // straight away, as an engaged follow-up: no tick, no silence
    expect(p.addressedBy?.text).toBe("駅前のところ、行ってみたいんだよね");
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

  it("a name whose transcript lands mid-greeting is answered when the greeting ends (sims 52, 60)", () => {
    // 「ゆい、今日の予定を教えて」 ended 0.4 s before the room went quiet enough for the greeting; its
    // final transcript arrived 2 s later, while the greeting was being spoken, and was only counted.
    const p = quiet();
    p.onSpeechActivity(true, 500);
    expect(p.onJoined(1000)).toBe(false);
    p.onSpeechActivity(false, 1800);
    p.tick(4400); // silence → OBSERVING
    p.tick(4600); // the greeting takes the floor
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("joined the meeting");
    p.markResponding(5000);
    p.onTranscript({ text: "ゆい、今日の予定を教えて。", final: true, speakerName: "Tester" }, 5800);
    expect(p.state).toBe("RESPONDING"); // never interrupts itself
    p.onAssistantDone(9000);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.text).toBe("ゆい、今日の予定を教えて。");
    expect(p.addressedBy?.speakerName).toBe("Tester");
    expect(p.engagementState).toBe("ENGAGED");
    // Consumed once: the turn after this one ends on the silence as usual.
    p.markResponding(9100);
    p.onAssistantDone(12_000);
    expect(p.state).toBe("OBSERVING");
  });

  it("a held name is dropped when the reply is cut off: whoever cut in brings their own transcript", () => {
    const p = quiet();
    p.onJoined(1000);
    p.markResponding(1100);
    p.onTranscript({ text: "ゆい、こんにちは", final: true }, 1500);
    p.onInterrupted(2000);
    expect(p.state).toBe("OBSERVING");
    expect(p.addressedBy).toBeNull();
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

describe("how forward the character is by default", () => {
  it("opens up for one-to-one and keeps a meeting to its name", () => {
    // The ordinary case: someone talks to the character. Waiting to be called by name is a summons.
    expect(defaultProactivityFor({ mode: "free_talk" })).toBe("open");
    expect(defaultProactivityFor({ personaId: "friend_ja", mode: "companion" })).toBe("open");
    expect(defaultProactivityFor({})).toBe("open");
    // A meeting is several people talking to each other: answering everything said is the failure.
    expect(defaultProactivityFor({ personaId: MEETING_PERSONA_ID })).toBe("addressed_only");
    expect(defaultProactivityFor({ mode: "meeting" })).toBe("addressed_only");
  });
});
});

/**
 * A speech-to-speech provider does its own turn-taking: it hears the room stop and starts answering
 * about a second later, while this policy is still waiting out the pause. On 2026-09-07 a one-to-one
 * Gemini run took 48 transcripts and gave no answer at all, because every reply the model began was
 * cut for arriving before the page had decided the turn was ours.
 */
describe("a turn the provider took on its own", () => {
  it("is adopted in a one-to-one, as an answer to what the room just said", () => {
    const p = make();
    let t = 1000;
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true, participantId: "p1" }, t);
    t += 900; // the provider endpoints and starts talking, long before the policy's own timer
    expect(p.acceptSelfTurn(t)).toBe(true);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.text).toBe("今日は雨がひどかったですね");
    expect(p.engagedWith?.participantId).toBe("p1");
    // And the page must not then ask for the answer a second time.
    expect(p.addressedBy?.detection.reason).toBe("answered on its own");
  });

  it("is refused where the character speaks only when spoken to", () => {
    const p = new ParticipationPolicy({ names: ["Yui", "ゆい"], proactivity: "addressed_only" });
    let t = 1000;
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true }, t);
    expect(p.acceptSelfTurn(t + 900)).toBe(false);
    expect(p.state).toBe("LISTENING");
  });

  it("is refused when the room has not spoken since the last answer, and when nobody has spoken at all", () => {
    const p = make();
    let t = 1000;
    expect(p.acceptSelfTurn(t)).toBe(false); // a model talking to itself
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true }, t);
    t += 900;
    expect(p.acceptSelfTurn(t)).toBe(true);
    p.markResponding(t);
    p.onAssistantDone(t + 2000);
    // Nothing new was said: the next thing the model starts is a monologue, not an answer.
    expect(p.acceptSelfTurn(t + 2500)).toBe(false);
    p.onTranscript({ text: "そうですね、傘が壊れました", final: true }, t + 3000);
    expect(p.acceptSelfTurn(t + 3600)).toBe(true);
  });

  it("is refused for a reply to something said a minute ago", () => {
    const p = make();
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true }, 1000);
    expect(p.acceptSelfTurn(1000 + 60_000)).toBe(false);
  });
});

/**
 * The transcript can arrive after the answer it belongs to. Gemini transcribes and answers in one
 * pass and delivers the user's final text with `turnComplete` — the end of *its own* reply — so a
 * turn that waits for the words is refused every time: 14 answers begun, 8 cut, 4 transcripts in ten
 * minutes of a real one-to-one (2026-09-07). Being heard is enough.
 */
describe("a turn taken before the words arrive", () => {
  it("is taken on the room having spoken, with no transcript yet", () => {
    const p = make();
    let t = 1000;
    p.onSpeechActivity(true, t, "Tester");
    p.onSpeechActivity(false, t + 1200, "Tester");
    expect(p.acceptSelfTurn(t + 1500)).toBe(true);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.detection.reason).toBe("answered on its own");
  });

  it("still refuses when nothing was heard, and when it was heard before the last answer", () => {
    const p = make();
    let t = 1000;
    expect(p.acceptSelfTurn(t)).toBe(false); // silence
    p.onSpeechActivity(true, t, "Tester");
    expect(p.acceptSelfTurn(t + 500)).toBe(true);
    p.markResponding(t + 500);
    p.onAssistantDone(t + 3000);
    expect(p.acceptSelfTurn(t + 3200)).toBe(false); // nothing said since she finished
    p.onSpeechActivity(true, t + 4000, "Tester");
    expect(p.acceptSelfTurn(t + 4200)).toBe(true);
  });

  it("prefers the transcript when there is one, so the answer knows what it answers", () => {
    const p = make();
    let t = 1000;
    p.onSpeechActivity(true, t, "Tester");
    p.onTranscript({ text: "今日は雨がひどかったですね", final: true, participantId: "p1" }, t + 800);
    expect(p.acceptSelfTurn(t + 1200)).toBe(true);
    expect(p.addressedBy?.text).toBe("今日は雨がひどかったですね");
  });
});


it("native audio turns continue across exchanges without a transcript, but require fresh speech", () => {
  const policy = new ParticipationPolicy({ names: ["Yui"], proactivity: "addressed_only" });
  expect(policy.acceptSelfTurn(1000, true)).toBe(false);
  for (let i = 1; i <= 5; i++) {
    const now = i * 10000;
    policy.onSpeechActivity(true, now);
    expect(policy.acceptSelfTurn(now + 1000, true)).toBe(true);
    policy.markResponding(now + 1000);
    policy.onAssistantDone(now + 2000);
    expect(policy.acceptSelfTurn(now + 3000, true)).toBe(false);
  }
});
