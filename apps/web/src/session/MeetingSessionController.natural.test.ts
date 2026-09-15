import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCharacter, type AvatarProvider } from "@rcai/avatar-core";
import type { ConversationEvent } from "@rcai/conversation-core";
import type { AvatarFactoryOptions } from "../integrations/registry.js";

const outbound = vi.fn();
const eof = vi.fn(async () => {});
const leave = vi.fn(async () => {});
const localPlay = vi.fn(() => true);
const attached = vi.fn();
const endLocalTurn = vi.fn();
const providerConnect = vi.fn(async () => {});
const providerListeners: Array<(event: ConversationEvent) => void> = [];
const madeAvatars: Array<AvatarProvider & { source: ReturnType<typeof vi.fn>; ended: ReturnType<typeof vi.fn> }> = [];
const makeAvatar = vi.fn(async (_renderer: string, options: AvatarFactoryOptions) => {
  const source = vi.fn();
  const ended = vi.fn();
  const avatar = {
    id: "live2d", source, ended,
    synchronizedAudio: options.quality === "natural" ? {
      pushSourceAudio: source, endSourceTurn: ended,
      getOutputStream: () => ({}) as MediaStream,
      onFailure: () => () => {},
    } : undefined,
    prepare: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    pushAudio() {}, setState() {}, setEmotion() {}, performGesture() {}, setGaze() {}, interrupt: vi.fn(),
    useLocalFallback() { avatar.synchronizedAudio = undefined; },
  };
  madeAvatars.push(avatar);
  return avatar;
});
const makeConnector = vi.fn(async (_provider: string, _options: unknown) => ({
  async join() { return meetingSession(); },
}));
function meetingSession() {
  return { id: "test-bot", status: () => "in_call", onEvent() {}, pushOutboundAudio: outbound, endOutboundUtterance: eof, leave };
}

vi.mock("@rcai/audio-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@rcai/audio-core")>();
  class SpeakerOutput {
    context = { state: "running", currentTime: 0, sampleRate: 48000 };
    tap = new original.AudioTap();
    isPlaying = false;
    async resume() {}
    async whenReady() {}
    play = localPlay;
    attachStream = attached;
    detachStream() {}
    resumeStream() {}
    endTurn = endLocalTurn;
    interrupt() { return 0; }
    async close() {}
  }
  class MicCapture {
    async start() { return {} as MediaStream; }
    async stop() {}
    onFrame() {}
  }
  return { ...original, SpeakerOutput, MicCapture };
});
vi.mock("@rcai/avatar-core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@rcai/avatar-core")>();
  return { ...original, loadCharacter: vi.fn(async () => ({ manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "p", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c", model: "original-yui.model3.json", expressions: {}, motions: {}, voice: { characterId: "yui", voices: {} } })) };
});
vi.mock("../integrations/registry.js", () => ({
  createAvatarProvider: (...args: Parameters<typeof makeAvatar>) => makeAvatar(...args),
  createMeetingConnector: (...args: Parameters<typeof makeConnector>) => makeConnector(...args),
  createConversationProvider: async () => ({
    id: "google", capabilities: () => ({}), connect: providerConnect,
    pushAudio() {}, async sendText() {}, async interrupt() {}, async disconnect() {}, async updateContext() {},
    onEvent(listener: (event: ConversationEvent) => void) { providerListeners.push(listener); },
  }),
}));
vi.mock("@rcai/connector-attendee", () => ({
  AttendeeConnector: class { attach() { return meetingSession(); } },
}));

import { MeetingSessionController, supportsSynchronizedPageOutput, validatedAvatarQuality, type MeetingInit } from "./MeetingSessionController.js";
import { DEFAULT_SETTINGS } from "../state/settings.js";

const controllers: MeetingSessionController[] = [];
function setup(overrides: Partial<MeetingInit> = {}) {
  const onError = vi.fn();
  const init: MeetingInit = {
    settings: { ...DEFAULT_SETTINGS, engine: "google", avatarQuality: { yui: "natural" } },
    availability: { openai: false, google: true, local: false },
    persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "yui", name: "Yui", aliases: ["ゆい"], renderer: "live2d", baseUrl: "/characters/yui" },
    meetingUrl: "https://meet.google.com/aaa-bbbb-ccc", displayName: "Yui", proactivity: "addressed_only",
    role: "bot", meetingProvider: "attendee", attendeeAttach: { botId: "test-bot", clientWsUrl: "ws://localhost:1/relay" },
    botActivation: { sessionId: "test-session", botId: "test-bot" },
    outboundPath: "page", connectorMode: "relay", visualCues: false, vision: false,
    stage: {} as HTMLElement,
    handlers: { onStatus() {}, onTranscript() {}, onPolicy() {}, onError },
    ...overrides,
  };
  const controller = new MeetingSessionController(init);
  controllers.push(controller);
  return { controller, onError };
}
const emit = (event: ConversationEvent) => { for (const listener of providerListeners) listener(event); };
const frame = () => ({ data: new Float32Array(480), sampleRate: 48000, channels: 1 as const, timestamp: Date.now() });

beforeEach(() => {
  vi.clearAllMocks();
  providerListeners.length = 0;
  madeAvatars.length = 0;
  vi.useFakeTimers();
});
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.leave();
  vi.useRealTimers();
});

describe("natural avatars in meeting pages", () => {
  it("accepts only the two signed quality values", () => {
    expect(validatedAvatarQuality("natural")).toBe("natural");
    expect(validatedAvatarQuality("lightweight")).toBe("lightweight");
    for (const value of [undefined, "anam", "Natural", "https://other-avatar", {}, true]) expect(validatedAvatarQuality(value)).toBeUndefined();
  });

  it("allows only bot pages capturing synchronized audio and video", () => {
    expect(supportsSynchronizedPageOutput({ role: "operator", outboundPath: "page" })).toBe(false);
    expect(supportsSynchronizedPageOutput({ role: "bot", meetingProvider: "recall" })).toBe(true);
    expect(supportsSynchronizedPageOutput({ role: "bot", meetingProvider: "attendee" })).toBe(false);
    const attendeeAttach = { botId: "bot", clientWsUrl: "ws://relay" };
    expect(supportsSynchronizedPageOutput({ role: "bot", meetingProvider: "attendee", attendeeAttach, outboundPath: "socket" })).toBe(false);
    expect(supportsSynchronizedPageOutput({ role: "bot", meetingProvider: "attendee", attendeeAttach, outboundPath: "page" })).toBe(true);
  });

  it("uses natural output once, never sends original PCM or source EOF over the socket", async () => {
    const { controller } = setup();
    await controller.start();
    expect(makeAvatar).toHaveBeenCalledWith("live2d", expect.objectContaining({ quality: "natural", characterId: "yui" }));
    controller.onMeetingTranscript("ゆい、こんにちは", true, "Host");
    emit({ type: "assistant_speech_started" });
    emit({ type: "assistant_audio", frame: frame() });
    emit({ type: "assistant_speech_ended" });
    expect(madeAvatars[0]!.source).toHaveBeenCalledOnce();
    expect(madeAvatars[0]!.ended).toHaveBeenCalledOnce();
    expect(attached).toHaveBeenCalledOnce();
    expect(localPlay).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
    expect(eof).not.toHaveBeenCalled();
    expect(endLocalTurn).not.toHaveBeenCalled();
  });

  it("keeps socket meetings lightweight and reports the supported-route limitation", async () => {
    const { controller, onError } = setup({ outboundPath: "socket" });
    await controller.start();
    expect(makeAvatar).toHaveBeenCalledWith("live2d", expect.objectContaining({ quality: "lightweight" }));
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("軽量表示"), "AVATAR_FALLBACK");
    controller.onMeetingTranscript("ゆい、こんにちは", true, "Host");
    emit({ type: "assistant_speech_started" });
    emit({ type: "assistant_audio", frame: frame() });
    emit({ type: "assistant_speech_ended" });
    expect(localPlay).toHaveBeenCalledOnce();
    expect(outbound).toHaveBeenCalledOnce();
    expect(eof).toHaveBeenCalledOnce();
  });

  it("carries natural selection to the signed bot query while the operator relay stays lightweight", async () => {
    const { controller } = setup({ role: "operator", attendeeAttach: undefined });
    await controller.start();
    expect(makeConnector).toHaveBeenCalledWith("attendee", expect.objectContaining({ botPageQuery: expect.objectContaining({ avatarQuality: "natural", character: "yui" }) }));
    expect(makeAvatar).toHaveBeenCalledWith("live2d", expect.objectContaining({ quality: "lightweight" }));
  });

  it("honors explicit lightweight bot selection ahead of a natural local preference", async () => {
    const { controller, onError } = setup({ avatarQuality: "lightweight" });
    await controller.start();
    expect(makeAvatar).toHaveBeenCalledWith("live2d", expect.objectContaining({ quality: "lightweight" }));
    expect(onError).not.toHaveBeenCalled();
  });

  it("supports Recall bot page output with natural rendering", async () => {
    const { controller } = setup({ meetingProvider: "recall", attendeeAttach: undefined });
    await controller.start();
    expect(makeAvatar).toHaveBeenCalledWith("live2d", expect.objectContaining({ quality: "natural" }));
  });

  it("loads the original human GLB character pack for lightweight and natural selection", async () => {
    const { controller } = setup({ character: { id: "sora", name: "Sora", renderer: "human-glb", baseUrl: "/characters/sora" }, avatarQuality: "natural" });
    await controller.start();
    expect(loadCharacter).toHaveBeenCalledWith("/characters/sora");
    expect(makeAvatar).toHaveBeenCalledWith("human-glb", expect.objectContaining({ quality: "natural", characterId: "sora" }));
  });

  it("blocks a late untagged audio frame after host mute instead of playing it through fallback", async () => {
    const { controller } = setup();
    await controller.start();
    controller.onMeetingTranscript("ゆい、こんにちは", true, "Host");
    emit({ type: "assistant_speech_started" });
    emit({ type: "assistant_audio", frame: frame() });
    const avatar = madeAvatars[0]!;
    expect(avatar.source).toHaveBeenCalledOnce();
    controller.reportHostMute(true);
    emit({ type: "assistant_audio", frame: frame() });
    expect(avatar.source).toHaveBeenCalledOnce();
    expect(localPlay).not.toHaveBeenCalled();
    expect(outbound).not.toHaveBeenCalled();
  });

  it("releases a renderer factory that completes after leaving and never starts its voice", async () => {
    let resolve!: (avatar: AvatarProvider) => void;
    const delayed = new Promise<AvatarProvider>((r) => { resolve = r; });
    const stop = vi.fn(async () => {});
    makeAvatar.mockImplementationOnce(() => delayed as ReturnType<typeof makeAvatar>);
    const { controller } = setup();
    const starting = expect(controller.start()).rejects.toThrow("MEETING_START_CANCELLED");
    await vi.advanceTimersByTimeAsync(0);
    await controller.leave();
    resolve({ id: "late", stop, prepare: vi.fn(), start: vi.fn(), pushAudio() {}, setState() {}, setEmotion() {}, performGesture() {}, setGaze() {}, interrupt() {} });
    await starting;
    expect(stop).toHaveBeenCalledOnce();
    expect(providerConnect).not.toHaveBeenCalled();
    await expect(controller.start()).rejects.toThrow("MEETING_START_CANCELLED");
  });
});
