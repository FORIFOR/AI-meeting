import { describe, expect, it, vi } from "vitest";

/**
 * A meeting vendor runs the bot page in its own browser, and Attendee's has no WebGL
 * (`--disable-gpu`, no swiftshader override — measured, docs/commercial-gate.md). Live2D cannot
 * draw there. What must not happen is losing the character's voice over it: a meeting where the
 * character is heard but not seen still works; one that refuses to start does not.
 */
const providerConnect = vi.fn(async () => {});

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
  createAvatarProvider: async () => { throw new Error("BLOCKED_BY_NO_WEBGL: live2d needs a WebGL context and this browser has none"); },
  createConversationProvider: async () => ({
    id: "local",
    capabilities: () => ({}),
    connect: providerConnect,
    pushAudio() {},
    async sendText() {},
    async interrupt() {},
    async updateContext() {},
    async disconnect() {},
    onEvent() {},
  }),
  createMeetingConnector: async () => ({
    async join() {
      return {
        status: () => "in_call",
        onEvent() {},
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

describe("a meeting whose browser cannot render the avatar", () => {
  it("reports why, and still starts the conversation", async () => {
    const errors: { message: string; code?: string }[] = [];
    const c = new MeetingSessionController({
      settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "default", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true, voices: {} },
      availability: { openai: false, google: false, local: true },
      persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
      character: { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/c/yui" },
      meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
      displayName: "Yui",
      proactivity: "addressed_only",
      role: "operator",
      connectorMode: "relay",
      stage: {} as HTMLElement,
      handlers: {
        onStatus() {}, onTranscript() {}, onPolicy() {},
        onError(message, code) { errors.push({ message, code }); },
      },
    });

    await c.start();
    expect(errors.map((e) => e.code)).toContain("AVATAR_NO_WEBGL");
    expect(c.avatarFailure).toMatch(/BLOCKED_BY_NO_WEBGL/);
    // The point of the whole exercise: the character still has a voice.
    expect(providerConnect).toHaveBeenCalledTimes(1);
    await c.leave();
  });
});
