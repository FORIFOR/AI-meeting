import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@rcai/conversation-core";
import type { MeetingEvent } from "@rcai/meeting-core";

/**
 * The AI's session closes under a live meeting. Gate #8 run 81 pass 2: the agent's WebSocket closed
 * 40 s into the pass, nothing logged on either side; the ears kept delivering the room and the character
 * sat silent through four questions. The controller must bring a new session up behind the same avatar
 * and speaker, and must not mistake its own `leave()` for that.
 */
const sendText = vi.fn(async () => {});
const interrupt = vi.fn(async () => {});
const connects: number[] = [];
let connectFails = 0;
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
  createConversationProvider: async () => {
    const n = connects.length + 1;
    return {
      id: "local", capabilities: () => ({}),
      async connect() { connects.push(n); if (connectFails > 0) { connectFails--; throw new Error("agent connection failed"); } },
      pushAudio() {}, sendText, interrupt, async updateContext() {}, async disconnect() {},
      onEvent(cb: (e: ConversationEvent) => void) { emit = cb; },
    };
  },
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

import { MeetingSessionController } from "./MeetingSessionController.js";

function controller() {
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
    handlers: { onStatus() {}, onTranscript() {}, onPolicy() {}, onError() {} },
  });
}

const flush = () => vi.advanceTimersByTimeAsync(5);
const settle = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(1000); };
/** Real timers carry the pipeline up (its audio grace period); the clock is faked only once it stands. */
async function started() {
  const c = controller();
  await c.start();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  return c;
}

describe("agent session closes under the meeting", () => {
  beforeEach(() => { connects.length = 0; connectFails = 0; sendText.mockClear(); interrupt.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("brings up a new session and answers the next question on it", async () => {
    const c = await started();
    expect(connects).toEqual([1]);
    emit!({ type: "session_closed" });
    await settle();
    expect(connects).toEqual([1, 2]);
    room!({ type: "speech", participant: { id: "tester", name: null }, active: true, at: Date.now() });
    emit!({ type: "user_transcript", text: "ゆい、今日の予定を教えて。", final: true, id: 7 });
    await flush();
    expect(c.policy.state).toBe("ADDRESSED");
    expect(sendText).toHaveBeenCalledTimes(1);
    await c.leave();
  });

  it("keeps trying while the agent stays down", async () => {
    const c = await started();
    connectFails = 2;
    emit!({ type: "session_closed" });
    await settle(); // 1 s, 2 s, 4 s: two failures, then the third attempt connects
    expect(connects).toEqual([1, 2, 3, 4]);
    await c.leave();
  });

  it("a turn in flight is given up, not waited for", async () => {
    const c = await started();
    emit!({ type: "user_transcript", text: "ゆい、今日の予定を教えて。", final: true, id: 1 });
    await flush();
    expect(c.policy.state).toBe("ADDRESSED");
    emit!({ type: "session_closed" });
    expect(c.policy.state).not.toBe("ADDRESSED");
    await settle();
    expect(connects).toEqual([1, 2]);
    await c.leave();
  });

  it("its own leave() is not a reason to reconnect", async () => {
    const c = await started();
    await c.leave(); // runtime.stop() emits session_closed
    await settle();
    expect(connects).toEqual([1]);
  });
});
