import { describe, expect, it } from "vitest";
import { AddressDetector } from "./addressDetector.js";
import { ParticipationPolicy } from "./participationPolicy.js";
import { detectPlatform } from "./types.js";

const det = new AddressDetector({ names: ["Yui", "ゆい", "結衣", "Astra"] });

describe("AddressDetector", () => {
  const addressed = [
    "Yuiさんはどう思う？",
    "ゆいさん、この案についてどう思いますか",
    "結衣、意見ある？",
    "Yui, what do you think about the timeline?",
    "Hey Yui, can you summarize that?",
    "Astraさんに聞きたいんだけど、リスクは何？",
    "AIさん、これ説明して",
    "この件、Yuiさん？",
    "ゆいちゃん教えて",
    "What's your take, Yui?",
  ];
  const notAddressed = [
    "ゆいさんはどう思ってるんだろうね",
    "Yui said the deadline is Friday.",
    "結衣さんのことは後で話しましょう",
    "I wonder what Yui thinks about it",
    "ゆいさんが言ってたやつ、あれ良かったね",
    "今日の議題は三つあります",
    "田中さんはどう思いますか？",
    "Let's move on to the next item.",
  ];
  for (const t of addressed) it(`addressed: ${t}`, () => expect(det.detect(t).addressed).toBe(true));
  for (const t of notAddressed) it(`not addressed: ${t}`, () => expect(det.detect(t).addressed).toBe(false));
  it("detects invitations without a name", () => {
    expect(det.detect("誰か意見ある人いますか？").invited).toBe(true);
    expect(det.detect("Anyone have thoughts on this?").invited).toBe(true);
    expect(det.detect("AIに聞いてみようか").invited).toBe(true);
    expect(det.detect("次に進みます").invited).toBe(false);
  });
  it("name without a request is not addressed", () => {
    const d = det.detect("Yuiも参加してます");
    expect(d.addressed).toBe(false);
    expect(d.reason).toMatch(/without a request/);
  });
});

describe("ParticipationPolicy", () => {
  it("observes, listens, responds only when addressed, then cools down", () => {
    const p = new ParticipationPolicy({ names: ["Yui"], cooldownMs: 3000, maxConsecutiveResponses: 2, silenceGapMs: 2000 });
    expect(p.state).toBe("OBSERVING");
    p.onSpeechActivity(true, 1000, "Tanaka");
    expect(p.state).toBe("LISTENING");
    p.onTranscript({ text: "今日の議題は三つあります", final: true, speakerName: "Tanaka" }, 1500);
    expect(p.shouldRespond(1600)).toBe(false);
    p.onTranscript({ text: "Yuiさんはどう思う？", final: false, speakerName: "Tanaka" }, 2000);
    expect(p.state).toBe("LISTENING"); // partials never trigger
    p.onTranscript({ text: "Yuiさんはどう思う？", final: true, speakerName: "Tanaka" }, 2200);
    expect(p.state).toBe("ADDRESSED");
    expect(p.addressedBy?.text).toContain("Yui");
    expect(p.shouldRespond(2300)).toBe(true);
    p.markResponding(2500);
    expect(p.state).toBe("RESPONDING");
    p.onAssistantDone(6000);
    expect(p.state).toBe("OBSERVING");
    // within cooldown: a name is still a name — the room asked, the character answers (run 46 dropped
    // 「ゆい、今どう思う？」 2.6 s after finishing, and to the asker that was a character not answering)
    p.onTranscript({ text: "Yui、もう一回？", final: true, speakerName: "Tanaka" }, 7000);
    expect(p.state).toBe("ADDRESSED");
  });
  it("cools down on its own initiative: an invitation right after answering is not taken", () => {
    const p = new ParticipationPolicy({ names: ["Yui"], proactivity: "invited", cooldownMs: 3000 });
    p.onTranscript({ text: "Yuiさんはどう思う？", final: true, speakerName: "Tanaka" }, 2200);
    p.markResponding(2500);
    p.onAssistantDone(6000);
    // within cooldown: an open invitation is ignored
    p.onTranscript({ text: "誰か意見ある？", final: true, speakerName: "Tanaka" }, 7000);
    expect(p.state).toBe("LISTENING");
    // after cooldown it works again
    p.onTranscript({ text: "誰か意見ある？", final: true, speakerName: "Tanaka" }, 9500);
    expect(p.state).toBe("ADDRESSED");
  });
  it("ignores its own transcript and falls back to OBSERVING on silence", () => {
    const p = new ParticipationPolicy({ names: ["Yui"], silenceGapMs: 1000 });
    p.onTranscript({ text: "Yui、どう思う？", final: true, speakerName: "Yui" }, 100);
    expect(p.state).toBe("OBSERVING");
    p.onSpeechActivity(true, 200, "Sato");
    expect(p.state).toBe("LISTENING");
    p.tick(1500);
    expect(p.state).toBe("OBSERVING");
  });
  it("caps consecutive responses and resets when others are addressed", () => {
    const p = new ParticipationPolicy({ names: ["Yui"], proactivity: "invited", cooldownMs: 0, maxConsecutiveResponses: 1 });
    p.onTranscript({ text: "Yui、意見は？", final: true, speakerName: "A" }, 100);
    p.markResponding(200);
    p.onAssistantDone(300);
    p.onTranscript({ text: "他に意見ある人？", final: true, speakerName: "A" }, 400);
    expect(p.state).toBe("LISTENING"); // capped: the floor is open, but the character just had it
    p.onTranscript({ text: "Yui、もう一つ？", final: true, speakerName: "A" }, 450);
    expect(p.state).toBe("ADDRESSED"); // the cap never applies to being called by name
    p.markResponding(460);
    p.onAssistantDone(470);
    p.onTranscript({ text: "田中さんはどう？", final: true, speakerName: "A" }, 500);
    p.onTranscript({ text: "他に意見ある人？", final: true, speakerName: "A" }, 600);
    expect(p.state).toBe("ADDRESSED"); // someone else was addressed in between: the count reset
  });
  it("invited/active proactivity", () => {
    const only = new ParticipationPolicy({ names: ["Yui"] });
    only.onTranscript({ text: "誰か意見ある？", final: true, speakerName: "A" }, 100);
    expect(only.state).toBe("LISTENING");
    const inv = new ParticipationPolicy({ names: ["Yui"], proactivity: "invited" });
    inv.onTranscript({ text: "誰か意見ある？", final: true, speakerName: "A" }, 100);
    expect(inv.state).toBe("ADDRESSED");
    const act = new ParticipationPolicy({ names: ["Yui"], proactivity: "active", silenceGapMs: 500, activeSilenceMs: 400 });
    act.onTranscript({ text: "来週のリリースは間に合いますか？", final: true, speakerName: "A" }, 100);
    expect(act.state).toBe("LISTENING");
    act.tick(1000);
    expect(act.state).toBe("ADDRESSED");
  });
});

describe("detectPlatform", () => {
  it("recognises meeting URLs", () => {
    expect(detectPlatform("https://meet.google.com/abc-defg-hij")).toBe("google_meet");
    expect(detectPlatform("https://us02web.zoom.us/j/1234567890")).toBe("zoom");
    expect(detectPlatform("https://teams.microsoft.com/l/meetup-join/x")).toBe("teams");
    expect(detectPlatform("not a url")).toBe("unknown");
  });
});
