import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent } from "@rcai/conversation-core";

/**
 * The AI recogniser's second, better reading of a line arrives after the line was delivered
 * (`user_transcript_revised`). It changes what later turns read and what the screen shows — and
 * nothing else: a revision must never become a turn of its own.
 */
const sendText = vi.fn(async () => {});
let emit: ((e: ConversationEvent) => void) | null = null;

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

describe("a revised reading of a line already heard", () => {
  it("replaces the context a later turn reads and the line on screen, and is never a turn", async () => {
    sendText.mockClear();
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    expect(emit).not.toBeNull();
    emit!({ type: "user_transcript", text: "メだよ 3定リ目の数字が 少し気になったかな。", final: true, id: 7 });
    emit!({ type: "user_transcript_revised", id: 7, text: "見たよ。三ページ目の数字が少し気になったかな。" });
    expect(sendText).not.toHaveBeenCalled();
    expect(c.policy.state).not.toBe("ADDRESSED");
    const shown = lines.filter((l) => l.final && !l.self);
    expect(shown.map((l) => l.text)).toEqual(["メだよ 3定リ目の数字が 少し気になったかな。", "見たよ。三ページ目の数字が少し気になったかな。"]);
    expect(shown[0]!.id).toBe(shown[1]!.id); // same line, better words — not a second line
    emit!({ type: "user_transcript", text: "あそこは後で直しておくね。", final: true, id: 8 });
    emit!({ type: "user_transcript", text: "Yui、今どう思う？", final: true, id: 9 });
    await new Promise((r) => setTimeout(r, 5));
    expect(sendText).toHaveBeenCalledTimes(1);
    const prompt = (sendText.mock.calls[0] as unknown as [string])[0];
    expect(prompt).toContain("三ページ目の数字");
    expect(prompt).not.toContain("3定リ目");
    // Every line before the address is context — including the one right before it — and the address itself is not repeated there.
    expect(prompt).toContain("?: あそこは後で直しておくね。");
    expect(prompt.indexOf("Yui、今どう思う？")).toBe(prompt.lastIndexOf("Yui、今どう思う？"));
    await c.leave();
  });

  it("a revision for a line it never delivered is ignored", async () => {
    sendText.mockClear();
    const lines: MeetingTranscriptLine[] = [];
    const c = controller(lines);
    await c.start();
    emit!({ type: "user_transcript_revised", id: 99, text: "何か" });
    expect(lines.filter((l) => l.final && !l.self)).toEqual([]);
    expect(sendText).not.toHaveBeenCalled();
    await c.leave();
  });
});
