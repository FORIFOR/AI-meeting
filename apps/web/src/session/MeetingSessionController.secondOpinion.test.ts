import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@rcai/conversation-core";
import type { MeetingEvent } from "@rcai/meeting-core";

/**
 * The recogniser's second, better reading of a line as a second opinion on the turn its first reading
 * earned. Gate #8 run 78 pass 3: 「ユが昨日そう言ってたよね。」 lost the name, became an engaged
 * follow-up and was answered; the rescore 1.9 s later read 「ユイが昨日そう言ってたよね」 — talk about
 * the character — while the answer was still a draft. The turn is withdrawn; nothing else changes.
 */
const sendText = vi.fn(async () => {});
const interrupt = vi.fn(async () => {});
let emit: ((e: ConversationEvent) => void) | null = null;
let room: ((e: MeetingEvent) => void) | null = null;

vi.mock("@rcai/audio-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/audio-core")>();
  class SpeakerOutput {
    context = { state: "running", close: async () => {}, sampleRate: 48000 };
    tap = new orig.AudioTap();
    isPlaying = false;
    async resume() {}
    async whenReady() {}
    play() { return true; }
    interrupt() { return 0; }
    async close() {}
  }
  return { ...orig, SpeakerOutput };
});

vi.mock("../integrations/registry.js", () => ({
  plannerUrl: () => "http://127.0.0.1:1/plan",
  createAvatarProvider: async () => { throw new Error("BLOCKED_BY_NO_WEBGL: not needed for this test"); },
  createConversationProvider: async () => ({
    id: "local", capabilities: () => ({}), async connect() {}, pushAudio() {}, sendText,
    interrupt, async updateContext() {}, async disconnect() {}, onEvent(cb: (e: ConversationEvent) => void) { emit = cb; },
  }),
  createMeetingConnector: async () => ({
    async join() {
      return {
        status: () => "in_call",
        onEvent(cb: (e: MeetingEvent) => void) { room = cb; cb({ type: "status", status: "in_call", at: Date.now() }); },
        async sendAudio() {},
        async leave() {},
      };
    },
  }),
}));

vi.mock("@rcai/avatar-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/avatar-core")>();
  return { ...orig, loadCharacter: async () => ({ manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c", model: "m", expressions: {}, motions: {}, voice: { characterId: "yui", voices: { local: "Kyoko" } } }) };
});

import { MeetingSessionController, type MeetingTranscriptLine } from "./MeetingSessionController.js";

function controller(lines: MeetingTranscriptLine[]) {
  return new MeetingSessionController({
    settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "default", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true, voices: {}, expressive: false },
    availability: { openai: false, google: false, local: true },
    persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/c/yui", aliases: ["ゆい", "ユイ"] },
    meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
    displayName: "Yui",
    proactivity: "addressed_only",
    role: "operator",
    connectorMode: "relay",
    stage: {} as HTMLElement,
    handlers: { onStatus() {}, onTranscript: (l) => lines.push(l), onPolicy() {}, onError() {} },
  });
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** The Tester asks by name, is answered, and the cooldown passes: the character is now in conversation with it. */
async function engaged(c: MeetingSessionController) {
  room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
  emit!({ type: "user_transcript", text: "Yui、今日の予定を教えて。", final: true, id: 1 });
  expect(c.policy.state).toBe("ADDRESSED");
  expect(c.policy.engagedWith?.participantId).toBe("tester");
  await tick();
  emit!({ type: "assistant_speech_started" });
  emit!({ type: "assistant_speech_ended" });
  expect(c.policy.state).toBe("OBSERVING");
  vi.setSystemTime(Date.now() + 5000); // past cooldownMs
}

describe("the rescore as a second opinion on a follow-up turn", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); sendText.mockClear(); interrupt.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("withdraws a follow-up the better reading says was talk about the character (run 78 pass 3)", async () => {
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    await engaged(c);
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "ユが昨日そう言ってたよね。", final: true, id: 2 });
    expect(c.policy.state).toBe("ADDRESSED");
    expect(c.policy.getHistory().at(-1)?.reason).toBe("engaged follow-up");
    await tick();
    expect(sendText).toHaveBeenCalledTimes(2); // the draft is being written
    emit!({ type: "user_transcript_revised", id: 2, text: "ユイが昨日そう言ってたよね" });
    expect(c.policy.state).toBe("OBSERVING");
    expect(c.policy.getHistory().at(-1)?.reason).toBe("withdrawn: name mentioned in third person");
    expect(interrupt).toHaveBeenCalledTimes(1); // the draft dies
    // The agent reports the cancelled draft; nothing of ours is sanctioned, so it is not an interruption of a turn.
    emit!({ type: "interrupted" });
    expect(c.policy.state).toBe("OBSERVING");
    expect(c.policy.engagedWith?.participantId).toBe("tester"); // still in conversation
    // The better words are what the screen and the next turn see.
    expect(lines.filter((l) => l.final && !l.self).at(-1)?.text).toBe("ユイが昨日そう言ってたよね");
    // Withdrawing spent nothing: the next real follow-up is answered straight away.
    vi.setSystemTime(Date.now() + 1000);
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "それって、来週までに終わりそう？", final: true, id: 3 });
    expect(c.policy.state).toBe("ADDRESSED");
    expect(c.policy.getHistory().at(-1)?.reason).toBe("engaged follow-up");
    await c.leave();
  });

  it("a better reading that agrees, or that names the character, leaves the turn alone", async () => {
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    await engaged(c);
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "それって来週までに終わりそう", final: true, id: 2 });
    expect(c.policy.state).toBe("ADDRESSED");
    emit!({ type: "user_transcript_revised", id: 2, text: "それって、来週までに終わりそう？" });
    expect(c.policy.state).toBe("ADDRESSED");
    emit!({ type: "user_transcript_revised", id: 2, text: "ゆい、それって来週までに終わりそう？" });
    expect(c.policy.state).toBe("ADDRESSED");
    expect(interrupt).not.toHaveBeenCalled();
    await c.leave();
  });

  it("once the character is speaking, the turn stands", async () => {
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    await engaged(c);
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "ユが昨日そう言ってたよね。", final: true, id: 2 });
    await tick();
    emit!({ type: "assistant_speech_started" });
    expect(c.policy.state).toBe("RESPONDING");
    emit!({ type: "user_transcript_revised", id: 2, text: "ユイが昨日そう言ってたよね" });
    expect(c.policy.state).toBe("RESPONDING");
    expect(interrupt).not.toHaveBeenCalled();
    await c.leave();
  });

  it("a turn taken on the name is never withdrawn by a rescore of it", async () => {
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "ゆい、今どう思う？", final: true, id: 1 });
    expect(c.policy.state).toBe("ADDRESSED");
    emit!({ type: "user_transcript_revised", id: 1, text: "ゆいがどう思うか言ってた" });
    expect(c.policy.state).toBe("ADDRESSED");
    expect(interrupt).not.toHaveBeenCalled();
    await c.leave();
  });
});
