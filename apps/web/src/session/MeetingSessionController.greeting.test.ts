import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first person to sit in a meeting with the character said it: 「入室した際に何も挨拶ないのは良く
 * ないです」. The bot page greets once, on the first frame of room audio — the moment it is actually in
 * the call — and that greeting is a sanctioned turn even in addressed_only, where nothing else lets
 * the character speak unasked.
 */
const sendText = vi.fn(async () => {});
const connect = vi.fn(async (_config: unknown) => {});
const providerInterrupt = vi.fn(async () => {});
/** What the fake agent says to the runtime — a test drives the provider side of a turn through this. */
const listeners: ((e: unknown) => void)[] = [];
const emit = (e: Record<string, unknown>) => { for (const l of listeners) l(e); };

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
    id: "local", capabilities: () => ({}), connect, pushAudio() {}, sendText,
    interrupt: providerInterrupt, async updateContext() {}, async disconnect() {}, onEvent(cb: (e: unknown) => void) { listeners.push(cb); },
  }),
  // The bot page is attached to Attendee and never creates a connector; the operator page joins through one.
  createMeetingConnector: async () => ({
    async join() {
      return { id: "bot_test", status: () => "in_call", onEvent() {}, pushOutboundAudio() {}, async endOutboundUtterance() {}, async leave() {}, close() {} };
    },
  }),
}));

vi.mock("@rcai/connector-attendee", () => ({
  AttendeeConnector: class {
    attach() {
      return { id: "bot_test", status: () => "in_call", onEvent() {}, pushOutboundAudio() {}, async endOutboundUtterance() {}, async leave() {}, close() {} };
    }
  },
}));

vi.mock("@rcai/avatar-core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@rcai/avatar-core")>();
  return { ...orig, loadCharacter: async () => ({ manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c", model: "m", expressions: {}, motions: {}, voice: { characterId: "yui", voices: { local: "Kyoko" } } }) };
});

import { MeetingSessionController } from "./MeetingSessionController.js";

function botPage(role: "bot" | "operator" = "bot") {
  return new MeetingSessionController({
    settings: { brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "default", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true, voices: {}, expressive: false },
    availability: { openai: false, google: false, local: true },
    persona: { id: "p", name: "P", mode: "free_talk", systemPrompt: "x", language: "ja-JP", speakingStyle: { speed: "normal", energy: 0.5, politeness: "casual", sentenceLength: "short" }, turnPolicy: { maxSentences: 2, allowSilenceMs: 2000, backchannel: true, interruptible: true, correctionPolicy: "none" }, motionProfile: "m" },
    character: { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/c/yui" },
    meetingUrl: "https://meet.google.com/aaa-bbbb-ccc",
    displayName: "Yui",
    proactivity: "addressed_only",
    role,
    connectorMode: "relay",
    stage: null as unknown as HTMLElement,
    botActivation: { sessionId: "s", botId: "bot_test" },
    attendeeAttach: { botId: "bot_test", clientWsUrl: "ws://localhost:1/relay" },
    handlers: { onStatus() {}, onTranscript() {}, onPolicy() {}, onError() {} },
  });
}

const frame = () => ({ data: new Float32Array(480), sampleRate: 48000, channels: 1 as const, timestamp: Date.now() });

describe("greeting on arrival", () => {
  beforeEach(() => { sendText.mockClear(); connect.mockClear(); providerInterrupt.mockClear(); listeners.length = 0; vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }); });
  afterEach(() => vi.useRealTimers());

  it("addressed_only bot page: the first room audio earns one greeting, a beat later", async () => {
    const c = botPage();
    await c.start();
    expect(sendText).not.toHaveBeenCalled();
    c.onMeetingAudio(frame());
    expect(c.policy.state).toBe("OBSERVING"); // not on the click of the admit button
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.policy.state).toBe("ADDRESSED");
    expect(sendText).toHaveBeenCalledTimes(1);
    const [prompt] = sendText.mock.calls[0] as unknown as [string];
    expect(prompt).toContain("【入室】");
    expect(prompt).toContain("「Yui」と呼びかければ");
    // Once. More audio is just the meeting.
    c.onMeetingAudio(frame());
    await vi.advanceTimersByTimeAsync(2000);
    expect(sendText).toHaveBeenCalledTimes(1);
    await c.leave();
  });

  /**
   * Gate #8 runs 6–8, with the recogniser finally hearing 「ゆい、今日の予定を教えて」: the page sanctioned
   * the turn, sent its text, and the agent's `interrupted` for the draft it had been writing on its own
   * made the page drop the sanction — so the real answer was cut as unsanctioned the moment it began.
   * A cancellation before our answer has started is not our answer being cut. A person speaking up
   * in that window is.
   */
  it("the agent cancelling its own draft does not end the sanctioned turn; a barge-in while thinking does", async () => {
    const c = botPage();
    await c.start();
    c.onMeetingAudio(frame());
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.policy.state).toBe("ADDRESSED");
    expect(sendText).toHaveBeenCalledTimes(1);

    emit({ type: "interrupted", at: Date.now() }); // the agent: `interrupt (text)` on its own draft
    expect(c.policy.state).toBe("ADDRESSED");
    emit({ type: "assistant_speech_started", at: Date.now() });
    expect(c.policy.state).toBe("RESPONDING"); // spoken, not cut
    expect(providerInterrupt).not.toHaveBeenCalled();
    emit({ type: "assistant_speech_ended", at: Date.now() });
    // Past the post-answer cooldown: the policy reads the clock, which the fake timers leave alone.
    const later = Date.now() + 5000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => later);

    // The next turn: someone starts talking while the answer is still being thought about.
    c.onMeetingTranscript("Yui、今どう思う？", true, "Tester", "p-1"); // the test character has no 「ゆい」 alias
    expect(c.policy.state).toBe("ADDRESSED");
    emit({ type: "user_speech_started", at: Date.now() });
    expect(c.policy.state).not.toBe("ADDRESSED");
    emit({ type: "assistant_speech_started", at: Date.now() });
    expect(providerInterrupt).toHaveBeenCalledTimes(1); // unsanctioned, cut
    clock.mockRestore();
    await c.leave();
  });

  /**
   * Gate #8 run 9: admission landed while the page was still opening its agent socket. The greeting
   * fired 1.5 s after the first frame, its text was dropped by a socket that was not open yet, and the
   * turn it had sanctioned sat ADDRESSED for 27 s — long enough for 「ゆい、今日の予定を教えて」 to find
   * the floor already taken. Room audio before the AI is connected does not start the greeting.
   */
  it("room audio before the agent is connected does not greet into the void", async () => {
    let ready!: () => void;
    connect.mockImplementationOnce(() => new Promise<void>((resolve) => { ready = resolve; }));
    const c = botPage();
    const starting = c.start();
    await vi.advanceTimersByTimeAsync(3000); // past the audio head start: the pipeline is now waiting on the agent
    c.onMeetingAudio(frame());
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.policy.state).toBe("OBSERVING");
    expect(sendText).not.toHaveBeenCalled();
    ready();
    await starting;
    c.onMeetingAudio(frame()); // the next frame after the connection is the one that counts
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.policy.state).toBe("ADDRESSED");
    expect(sendText).toHaveBeenCalledTimes(1);
    await c.leave();
  });

  /**
   * The other half of the same failure: a turn the AI never answers must not stay sanctioned. The
   * text was lost, or the model hung — either way the floor has to open again for the next address.
   */
  it("a sanctioned turn with no answer is released, and a lost text turn is released at once", async () => {
    const c = botPage();
    await c.start();
    c.onMeetingAudio(frame());
    await vi.advanceTimersByTimeAsync(1600);
    expect(c.policy.state).toBe("ADDRESSED");
    await vi.advanceTimersByTimeAsync(20_500); // nothing from the agent
    expect(c.policy.state).toBe("OBSERVING");

    const later = Date.now() + 30_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => later);
    sendText.mockImplementationOnce(async () => { throw new Error("agent socket not open"); });
    c.onMeetingTranscript("Yui、今どう思う？", true, "Tester", "p-1");
    expect(c.policy.state).toBe("ADDRESSED");
    await vi.advanceTimersByTimeAsync(10);
    expect(c.policy.state).toBe("OBSERVING"); // released as soon as the send failed, not 20 s later
    clock.mockRestore();
    await c.leave();
  });

  /**
   * Gate #8 runs 6–7: the greeting was cut after one audio frame because the recogniser's VAD fired on
   * an open mic in the room and the runtime's barge-in fast path did what it is for. A room needs the
   * speech to last before it counts; a person with a headset does not.
   */
  it("bot page asks the agent to confirm a barge-in; the operator page keeps the instant cut", async () => {
    await botPage("bot").start();
    const bot = connect.mock.calls.at(-1)![0] as { providerOptions?: Record<string, unknown> };
    expect(bot.providerOptions?.bargeInConfirmMs).toBe(600);
    expect(bot.providerOptions?.opening).toBeUndefined();
    await botPage("operator").start();
    const op = connect.mock.calls.at(-1)![0] as { providerOptions?: Record<string, unknown> };
    expect(op.providerOptions?.bargeInConfirmMs).toBeUndefined();
  });
});
