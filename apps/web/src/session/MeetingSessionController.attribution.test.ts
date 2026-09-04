import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@rcai/conversation-core";
import type { MeetingEvent } from "@rcai/meeting-core";

/**
 * Whose words the AI recogniser delivered. Attendee's transcripts carry no name; the page attaches
 * each line to a participant from their own audio stream. Gate #8 run 71: a host's open microphone
 * carried a television, its stream flickered above the floor every few seconds, and "the last stream
 * to go active" attached the Tester's question to the host — after which the television's chatter was
 * an engaged follow-up from the person the character had answered. Loudness over the utterance decides.
 */
const sendText = vi.fn(async () => {});
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
    async interrupt() {}, async updateContext() {}, async disconnect() {}, onEvent(cb: (e: ConversationEvent) => void) { emit = cb; },
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
    character: { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/c/yui" },
    meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
    displayName: "Yui",
    proactivity: "addressed_only",
    role: "operator",
    connectorMode: "relay",
    stage: {} as HTMLElement,
    handlers: { onStatus() {}, onTranscript: (l) => lines.push(l), onPolicy() {}, onError() {} },
  });
}

describe("who said it: loudness over the utterance, not the last stream to flicker", () => {
  it("attaches the question to the loud stream, so the open mic's chatter is not a follow-up", async () => {
    sendText.mockClear();
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    expect(room).not.toBeNull();
    const now = Date.now();
    // The host's stream: faint television, above the floor, flickering — and the last to go "active".
    for (let t = now - 3000; t <= now; t += 100) room!({ type: "speech_level", participantId: "host", level: -40, at: t });
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: now - 2600 });
    emit!({ type: "user_speech_started" });
    // The Tester asks, loudly, on its own stream.
    for (let t = now - 2500; t <= now - 300; t += 100) room!({ type: "speech_level", participantId: "tester", level: -18, at: t });
    room!({ type: "speech", participant: { id: "host", name: null }, active: true, at: now - 100 });
    emit!({ type: "user_speech_ended" });
    emit!({ type: "user_transcript", text: "Yui、今日の予定を教えて。", final: true, id: 1 });
    expect(c.policy.state).toBe("ADDRESSED");
    expect(c.policy.engagedWith?.participantId).toBe("tester");
    await c.leave();
  });

  it("no clear winner: the last stream to go active still stands", async () => {
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    const now = Date.now();
    for (let t = now - 2000; t <= now; t += 100) {
      room!({ type: "speech_level", participantId: "a", level: -20, at: t });
      room!({ type: "speech_level", participantId: "b", level: -21, at: t });
    }
    room!({ type: "speech", participant: { id: "b", name: null }, active: true, at: now - 50 });
    emit!({ type: "user_transcript", text: "Yui、今日の予定を教えて。", final: true, id: 1 });
    expect(c.policy.engagedWith?.participantId).toBe("b");
    await c.leave();
  });
});
