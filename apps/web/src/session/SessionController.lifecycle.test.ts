import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the heavy edges: audio devices and the vendor registry. Everything else is the real code.
const stopTrack = vi.fn();
const closeCtx = vi.fn(async () => {});
const providerDisconnect = vi.fn(async () => {});
const avatarStop = vi.fn(async () => {});
const micSetup = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); });
const avatarFactory = vi.fn(async () => {});
const avatarPrepare = vi.fn(async () => {});
const providerConnect = vi.fn(async () => { await new Promise((r) => setTimeout(r, 5)); });
const evaluate = vi.fn(async () => ({ overall: 0, clarity: 0, specificity: 0, structure: 0, relevance: 0, fluency: 0, feedback: [], improvedAnswer: "" }));

vi.mock("@rcai/audio-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/audio-core")>();
  class SpeakerOutput {
    context = { state: "running", close: closeCtx, sampleRate: 48000 };
    tap = new orig.AudioTap();
    isPlaying = false;
    closed = false;
    async resume() {}
    async whenReady() {}
    play() { return true; }
    interrupt() { return 0; }
    async close() { this.closed = true; await closeCtx(); }
  }
  class MicCapture {
    stream: { getTracks: () => { stop: typeof stopTrack }[] } | null = null;
    stopped = false;
    async start() {
      await micSetup();
      if (this.stopped) {
        stopTrack();
        throw new Error("MicCapture stopped");
      }
      this.stream = { getTracks: () => [{ stop: stopTrack }] };
      return this.stream;
    }
    onFrame() { return () => {}; }
    async stop() { this.stopped = true; this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null; }
    setMuted() {}
    get isMuted() { return false; }
    get mediaStream() { return this.stream; }
  }
  return { ...orig, SpeakerOutput, MicCapture };
});

vi.mock("../integrations/registry.js", () => ({
  plannerUrl: () => "http://127.0.0.1:1/plan",
  createHeuristicEvaluator: () => ({ id: "local", evaluate: async () => ({ overall: 0, clarity: 0, specificity: 0, structure: 0, relevance: 0, fluency: 0, feedback: [], improvedAnswer: "" }) }),
  createEvaluator: () => ({ id: "local", evaluate }),
  createAvatarProvider: async () => { await avatarFactory(); return ({
    id: "canvas",
    prepare: avatarPrepare,
    async start() { await new Promise((r) => setTimeout(r, 5)); },
    pushAudio() {},
    setState() {},
    setEmotion() {},
    performGesture() {},
    setGaze() {},
    interrupt() {},
    stop: avatarStop,
  }); },
  createConversationProvider: async () => ({
    id: "local",
    capabilities: () => ({}),
    connect: providerConnect,
    pushAudio() {},
    async sendText() {},
    async interrupt() {},
    async updateContext() {},
    disconnect: providerDisconnect,
    onEvent() {},
  }),
}));

vi.mock("@rcai/avatar-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/avatar-core")>();
  return { ...orig, loadCharacter: async () => ({ manifest: { id: "c", name: "C", renderer: "canvas", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c", model: "m", expressions: {}, motions: {}, voice: { characterId: "c", voices: {} } }) };
});

import { SessionController, SessionDisposedError } from "./SessionController.js";
import { getActiveSession } from "./activeSession.js";

function makeController(privacyMode: "strict_local" | "default" = "strict_local") {
  return new SessionController({
    settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode, showHud: false, characterId: "c", cameraOn: false, captionsOn: true, voices: {}, expressive: false },
    availability: { openai: false, google: false, local: true },
    persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "c", name: "C", renderer: "canvas", baseUrl: "/c" },
    params: {},
    stage: {} as HTMLElement,
    handlers: { onEvent() {}, onAvatarState() {}, onError() {}, onProviderChange() {} },
  });
}

describe("SessionController lifecycle", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  beforeEach(() => {
    vi.clearAllMocks();
    micSetup.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); });
    avatarFactory.mockImplementation(async () => {});
    avatarPrepare.mockImplementation(async () => {});
  });

  it("dispose() during start() aborts at the next checkpoint and releases everything", async () => {
    stopTrack.mockClear(); closeCtx.mockClear(); providerDisconnect.mockClear(); avatarStop.mockClear();
    const c = makeController();
    const starting = c.start();
    await new Promise((r) => setTimeout(r, 12)); // somewhere inside avatar/mic setup
    const disposing = c.dispose();
    await expect(starting).rejects.toBeInstanceOf(SessionDisposedError);
    await disposing;
    expect(c.isDisposed).toBe(true);
    expect(closeCtx).toHaveBeenCalledTimes(1);
    expect(getActiveSession()).toBeNull();
    // Nothing created after the abort point leaks: if the mic had started, its track was stopped.
    expect(stopTrack.mock.calls.length).toBeLessThanOrEqual(1);
    await c.dispose(); // idempotent
    expect(closeCtx).toHaveBeenCalledTimes(1);
  });

  it("full start → end closes the context exactly once and unregisters the active session", async () => {
    stopTrack.mockClear(); closeCtx.mockClear(); providerDisconnect.mockClear(); avatarStop.mockClear();
    const c = makeController();
    await c.start();
    expect(getActiveSession()).toBe(c);
    const out = await c.end();
    expect(out.providerId).toBe("local");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(providerDisconnect).toHaveBeenCalledTimes(1);
    expect(avatarStop).toHaveBeenCalledTimes(1);
    expect(closeCtx).toHaveBeenCalledTimes(1);
    expect(getActiveSession()).toBeNull();
    await c.dispose();
    expect(closeCtx).toHaveBeenCalledTimes(1);
  });

  it("loads the avatar while microphone permission is pending and waits for both before connecting", async () => {
    const permission = deferred();
    micSetup.mockReturnValue(permission.promise);
    const c = makeController();
    const starting = c.start();
    await vi.waitFor(() => expect(avatarPrepare).toHaveBeenCalledOnce());
    expect(micSetup).toHaveBeenCalledOnce();
    expect(providerConnect).not.toHaveBeenCalled();
    permission.resolve();
    await starting;
    expect(providerConnect).toHaveBeenCalledOnce();
    await c.dispose();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(closeCtx).toHaveBeenCalledOnce();
  });

  it("releases a late microphone grant after leaving during avatar loading", async () => {
    const permission = deferred();
    const assets = deferred();
    micSetup.mockReturnValue(permission.promise);
    avatarPrepare.mockReturnValue(assets.promise);
    const c = makeController();
    const starting = c.start();
    const rejected = expect(starting).rejects.toBeInstanceOf(SessionDisposedError);
    await vi.waitFor(() => expect(avatarPrepare).toHaveBeenCalledOnce());
    await c.dispose();
    permission.resolve();
    assets.resolve();
    await rejected;
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(providerConnect).not.toHaveBeenCalled();
    expect(avatarStop).toHaveBeenCalledOnce();
    expect(closeCtx).toHaveBeenCalledOnce();
  });

  it("observes an early permission denial while assets load and cleans up on failure", async () => {
    const assets = deferred();
    const denied = new Error("Microphone permission denied");
    micSetup.mockRejectedValue(denied);
    avatarPrepare.mockReturnValue(assets.promise);
    const c = makeController();
    const starting = c.start();
    const rejected = expect(starting).rejects.toBe(denied);
    await vi.waitFor(() => expect(avatarPrepare).toHaveBeenCalledOnce());
    assets.resolve();
    await rejected;
    expect(providerConnect).not.toHaveBeenCalled();
    expect(avatarStop).toHaveBeenCalledOnce();
    expect(closeCtx).toHaveBeenCalledOnce();
  });

  it("stops a renderer whose factory resolves after the session was disposed", async () => {
    const factory = deferred();
    avatarFactory.mockReturnValue(factory.promise);
    const c = makeController();
    const starting = c.start();
    const rejected = expect(starting).rejects.toBeInstanceOf(SessionDisposedError);
    await vi.waitFor(() => expect(avatarFactory).toHaveBeenCalledOnce());
    await c.dispose();
    factory.resolve();
    await rejected;
    expect(avatarStop).toHaveBeenCalledOnce();
    expect(avatarPrepare).not.toHaveBeenCalled();
    expect(providerConnect).not.toHaveBeenCalled();
    expect(closeCtx).toHaveBeenCalledOnce();
  });

  it("starts result evaluation while telemetry is still being delivered", async () => {
    const delivery = deferred();
    const fetchImpl = vi.fn(async () => { await delivery.promise; return new Response("{}"); });
    vi.stubGlobal("fetch", fetchImpl);
    const c = makeController("default");
    await c.start();
    const ending = c.end();
    try {
      await vi.waitFor(() => expect(evaluate).toHaveBeenCalledOnce());
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(stopTrack).toHaveBeenCalledOnce();
      expect(closeCtx).toHaveBeenCalledOnce();
    } finally {
      delivery.resolve();
    }
    expect((await ending).telemetry).toBe("sent");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
