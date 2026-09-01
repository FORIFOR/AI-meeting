import { describe, expect, it, vi } from "vitest";

/**
 * The proactive tiers enter ADDRESSED from the timer, not from a transcript: the trigger is the room
 * going quiet. Answering used to hang off the transcript handler, so those modes reached ADDRESSED and
 * nobody ever asked the AI to speak — the state machine looked right and the character stayed silent.
 */
const sendText = vi.fn(async () => {});

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
    async interrupt() {}, async updateContext() {}, async disconnect() {}, onEvent() {},
  }),
  createMeetingConnector: async () => ({
    async join() {
      return {
        status: () => "in_call",
        // The controller only believes it is admitted once the vendor says so; outbound speech is
        // held until then, so the fake has to say it.
        onEvent(cb: (e: unknown) => void) { cb({ type: "status", status: "in_call", at: Date.now() }); },
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

function controller(proactivity: "addressed_only" | "open") {
  return new MeetingSessionController({
    settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "default", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true, voices: {}, expressive: false },
    availability: { openai: false, google: false, local: true },
    persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/c/yui" },
    meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
    displayName: "Yui",
    proactivity,
    role: "operator",
    connectorMode: "relay",
    stage: {} as HTMLElement,
    handlers: { onStatus() {}, onTranscript() {}, onPolicy() {}, onError() {} },
  });
}

describe("speaking without being called", () => {
  it("open: ordinary conversation, then quiet, and the character takes a turn", async () => {
    sendText.mockClear();
    const c = controller("open");
    await c.start();
    c.policy.onTranscript({ text: "今日は雨がひどかったですね", final: true }, Date.now());
    expect(sendText).not.toHaveBeenCalled(); // someone may still be talking
    c.policy.tick(Date.now() + 3000); // the room goes quiet
    expect(c.policy.state).toBe("ADDRESSED");
    await new Promise((r) => setTimeout(r, 5));
    expect(sendText).toHaveBeenCalledTimes(1);
    await c.leave();
  });

  it("addressed_only is unchanged: the same conversation earns nothing", async () => {
    sendText.mockClear();
    const c = controller("addressed_only");
    await c.start();
    c.policy.onTranscript({ text: "今日は雨がひどかったですね", final: true }, Date.now());
    c.policy.tick(Date.now() + 3000);
    expect(c.policy.state).toBe("OBSERVING");
    expect(sendText).not.toHaveBeenCalled();
    await c.leave();
  });
});
