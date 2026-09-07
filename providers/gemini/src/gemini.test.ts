import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrame, float32ToBase64Pcm16 } from "@rcai/audio-core";
import type { ConversationEvent, SessionConfig } from "@rcai/conversation-core";
import { PrivacyViolationError } from "@rcai/provider-core";
import { GeminiLiveProvider, type WebSocketLike } from "./geminiLiveProvider.js";
import { createGeminiEvaluationProvider } from "./evaluation.js";
import { geminiWssUrl, parsePcmRate , DEFAULT_GEMINI_LIVE_MODEL } from "./protocol.js";

class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  closed: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }
  send(data: string) {
    const msg = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(msg);
    if ("setup" in msg) queueMicrotask(() => this.receive({ setupComplete: {} }));
  }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closed = { code, reason };
    this.onclose?.({ code, reason });
  }
  receive(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  async flush() {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

const tokenFetch = vi.fn(async (url: string, init?: RequestInit) => {
  if (url.endsWith("/api/token/gemini")) {
    // The broker echoes the model it minted the token for, which is how the provider learns whether it
    // got the model it asked for — an operator pin can override the request.
    const asked = init?.body ? (JSON.parse(String(init.body)) as { model?: string }).model : undefined;
    return new Response(JSON.stringify({ token: "auth_tokens/abc123", expiresAt: Date.now() + 60_000, model: asked ?? "gemini-3.1-flash-live-preview" }), { status: 200 });
  }
  if (url.endsWith("/api/evaluate")) {
    const body = JSON.parse(String(init?.body));
    expect(body.providerId).toBe("google");
    return new Response(JSON.stringify({ overall: 80, clarity: 80, specificity: 70, structure: 85, relevance: 90, fluency: 75, feedback: ["ok"], improvedAnswer: "..." }), { status: 200 });
  }
  return new Response("nope", { status: 404 });
}) as unknown as typeof fetch;

const config: SessionConfig = { systemPrompt: "あなたは面接官です。", mode: "interview", language: "ja-JP", voice: "Kore", privacyMode: "default" };

function sine(rate: number, ms: number, amp = 0.5, freq = 440): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

async function connected(extra: Partial<ConstructorParameters<typeof GeminiLiveProvider>[0]> = {}) {
  const p = new GeminiLiveProvider({ brokerUrl: "http://localhost:8787/", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u), clock: () => Date.now(), ...extra });
  const events: ConversationEvent[] = [];
  p.onEvent((e) => events.push(e));
  await p.connect(config);
  const ws = FakeWS.instances[FakeWS.instances.length - 1]!;
  await ws.flush();
  return { p, ws, events };
}

beforeEach(() => {
  FakeWS.instances = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => vi.useRealTimers());

describe("protocol helpers", () => {
  it("builds the v1beta WSS url with access_token and parses pcm rates", () => {
    expect(geminiWssUrl("v1beta", "auth_tokens/a b")).toBe(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fa%20b",
    );
    expect(parsePcmRate("audio/pcm;rate=24000")).toBe(24000);
    expect(parsePcmRate("audio/pcm")).toBe(24000);
  });
});

describe("GeminiLiveProvider", () => {
  it("fetches an ephemeral token from the broker, opens WSS and sends a correct setup", async () => {
    const { p, ws, events } = await connected();
    expect(tokenFetch).toHaveBeenCalledWith("http://localhost:8787/api/token/gemini", expect.objectContaining({ method: "POST" }));
    // An ephemeral token is only accepted on the constrained method; the plain one answers 1008.
    expect(ws.url).toContain("v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc123");
    const setup = (ws.sent[0] as unknown as { setup: ReturnType<GeminiLiveProvider["buildSetup"]> }).setup;
    expect(setup.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(setup.generationConfig?.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Kore");
    // The live models are not the native-audio family: they take an explicit languageCode and reject
    // enableAffectiveDialog outright (1007), so neither is sent the way it is for native audio.
    expect(setup.generationConfig?.speechConfig?.languageCode).toBe("ja-JP");
    expect(setup.generationConfig?.enableAffectiveDialog).toBeUndefined();
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    // Audio is gated on our own VAD (see pushAudio), so the server's detector is off and the turn
    // boundaries are ours: activityStart / activityEnd.
    expect(setup.realtimeInputConfig?.automaticActivityDetection?.disabled).toBe(true);
    const sys = setup.systemInstruction?.parts[0]?.text ?? "";
    expect(sys).toContain("あなたは面接官です。");
    expect(sys).toContain("【会話ルール】");
    expect(sys).toContain("最大3文");
    expect(setup.proactivity).toBeUndefined();
    expect(events[0]).toEqual({ type: "session_ready", providerId: "google" });
    expect(p.capabilities().extras?.affectiveDialog).toBe(true);
    await p.disconnect();
    expect(ws.closed?.code).toBe(1000);
  });

  it("exposes proactive audio + tools when configured, on a model that has it", async () => {
    // Proactive audio and affective dialog are native-audio-only. Sent to a flash-live model they come
    // back as 1007 "invalid argument", which reads as a broken client rather than an unsupported option.
    const p = new GeminiLiveProvider({ brokerUrl: "http://b", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u), proactiveAudio: true, enableAffectiveDialog: false, model: "gemini-2.5-flash-preview-native-audio-dialog" });
    await p.connect({ ...config, tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    const ws = FakeWS.instances[0]!;
    const setup = (ws.sent[0] as { setup: ReturnType<GeminiLiveProvider["buildSetup"]> }).setup;
    expect(setup.proactivity).toEqual({ proactiveAudio: true });
    expect(setup.generationConfig?.enableAffectiveDialog).toBeUndefined();
    expect(setup.tools?.[0]?.functionDeclarations[0]?.name).toBe("lookup");
    expect(p.capabilities().extras?.proactiveAudio).toBe(true);
  });

  it("does not send native-audio-only options to a flash-live model", async () => {
    const p = new GeminiLiveProvider({ brokerUrl: "http://b", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u), proactiveAudio: true, enableAffectiveDialog: true, model: "gemini-3.1-flash-live-preview" });
    await p.connect(config);
    const setup = (FakeWS.instances[0]!.sent[0] as { setup: ReturnType<GeminiLiveProvider["buildSetup"]> }).setup;
    expect(setup.proactivity).toBeUndefined();
    expect(setup.generationConfig?.enableAffectiveDialog).toBeUndefined();
  });

  it("converts 48k frames to 16k PCM16 base64 chunks of 640 bytes and emits local VAD events", async () => {
    let ts = 0;
    const { p, ws, events } = await connected();
    const quiet = () => createFrame(new Float32Array(960).fill(0.0005), 48000, ts);
    for (let i = 0; i < 20; i++) { p.pushAudio(quiet()); ts += 20; }
    for (let i = 0; i < 15; i++) { p.pushAudio(createFrame(sine(48000, 20), 48000, ts)); ts += 20; }
    for (let i = 0; i < 40; i++) { p.pushAudio(quiet()); ts += 20; }
    const inputs = ws.sent.filter((m) => "realtimeInput" in m) as { realtimeInput: { audio?: { data: string; mimeType: string }; activityStart?: unknown; activityEnd?: unknown } }[];
    const audio = inputs.filter((m) => m.realtimeInput.audio) as { realtimeInput: { audio: { data: string; mimeType: string } } }[];
    // 75 frames went in; the 40 quiet ones at the end are not paid for. What is sent is the speech and
    // the 300 ms of pre-roll before it, between one activityStart and one activityEnd.
    expect(inputs.filter((m) => m.realtimeInput.activityStart).length).toBe(1);
    expect(inputs.filter((m) => m.realtimeInput.activityEnd).length).toBe(1);
    expect(inputs[0]!.realtimeInput.activityStart).toBeDefined(); // nothing before the turn opens
    expect(audio.length).toBeGreaterThanOrEqual(15);
    expect(audio.length).toBeLessThan(75);
    expect(audio.every((m) => m.realtimeInput.audio.mimeType === "audio/pcm;rate=16000")).toBe(true);
    expect(audio.every((m) => Buffer.from(m.realtimeInput.audio.data, "base64").length === 640)).toBe(true);
    expect(events.filter((e) => e.type === "user_speech_started").length).toBe(1);
    expect(events.filter((e) => e.type === "user_speech_ended").length).toBe(1);
  });

  it("maps inbound 24k audio to 48k frames and emits speech started/ended around playback", async () => {
    const { p, ws, events } = await connected();
    const chunk = float32ToBase64Pcm16(sine(24000, 100)); // 100 ms
    ws.receive({ serverContent: { inputTranscription: { text: "こんに" } } });
    ws.receive({ serverContent: { inputTranscription: { text: "ちは" } } });
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: chunk } }] } } });
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: chunk } }] } } });
    ws.receive({ serverContent: { outputTranscription: { text: "やあ、" } } });
    ws.receive({ serverContent: { outputTranscription: { text: "元気？" } } });
    ws.receive({ serverContent: { generationComplete: true } });
    ws.receive({ serverContent: { turnComplete: true } });
    await ws.flush();
    const types = events.map((e) => e.type);
    expect(types.slice(0, 3)).toEqual(["session_ready", "user_transcript", "user_transcript"]);
    const userFinal = events.find((e) => e.type === "user_transcript" && e.final === true) as { text: string };
    expect(userFinal.text).toBe("こんにちは");
    expect(types.indexOf("user_transcript")).toBeLessThan(types.indexOf("assistant_speech_started"));
    const frames = events.filter((e) => e.type === "assistant_audio") as { frame: { data: Float32Array; sampleRate: number } }[];
    expect(frames.length).toBe(2);
    expect(frames[0]!.frame.sampleRate).toBe(48000);
    expect(Math.abs(frames[0]!.frame.data.length - 4800)).toBeLessThanOrEqual(2);
    const assistantFinal = events.filter((e) => e.type === "assistant_transcript").pop() as { text: string; final?: boolean };
    expect(assistantFinal).toMatchObject({ text: "やあ、元気？", final: true });
    expect(types).not.toContain("assistant_speech_ended"); // 200 ms of audio still playing
    vi.advanceTimersByTime(250);
    expect(events[events.length - 1]?.type).toBe("assistant_speech_ended");
    await p.disconnect();
  });

  it("maps interrupted / toolCall / goAway and explicit interrupt()", async () => {
    const { p, ws, events } = await connected();
    const chunk = float32ToBase64Pcm16(sine(24000, 500));
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: chunk } }] } } });
    ws.receive({ serverContent: { turnComplete: true } });
    ws.receive({ serverContent: { interrupted: true } });
    await ws.flush();
    expect(events.map((e) => e.type)).toEqual(["session_ready", "assistant_speech_started", "assistant_audio", "interrupted"]);
    vi.advanceTimersByTime(1000);
    expect(events.map((e) => e.type)).not.toContain("assistant_speech_ended"); // cancelled by interruption

    ws.receive({ toolCall: { functionCalls: [{ id: "c1", name: "lookup", args: { q: "x" } }] } });
    await ws.flush();
    const tc = events[events.length - 1] as { type: string; call: { id: string; name: string; arguments: Record<string, unknown> } };
    expect(tc.type).toBe("tool_call");
    expect(tc.call).toEqual({ id: "c1", name: "lookup", arguments: { q: "x" } });
    p.sendToolResponse([{ id: "c1", name: "lookup", response: { ok: true } }]);
    expect(ws.sent[ws.sent.length - 1]).toEqual({ toolResponse: { functionResponses: [{ id: "c1", name: "lookup", response: { ok: true } }] } });

    // explicit interrupt while speaking: local interrupted + clientContent sent
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: chunk } }] } } });
    await ws.flush();
    await p.interrupt();
    expect(ws.sent[ws.sent.length - 1]).toEqual({ clientContent: { turnComplete: false } });
    expect(events[events.length - 1]?.type).toBe("interrupted");

    await p.sendText("こんにちは");
    expect(ws.sent[ws.sent.length - 1]).toEqual({ clientContent: { turns: [{ role: "user", parts: [{ text: "こんにちは" }] }], turnComplete: true } });
    await p.updateContext({ systemPrompt: "新しい指示", mode: "free_talk", language: "ja-JP" });
    const upd = ws.sent[ws.sent.length - 1] as { clientContent: { turns: { parts: { text: string }[] }[]; turnComplete: boolean } };
    expect(upd.clientContent.turnComplete).toBe(false);
    expect(upd.clientContent.turns[0]!.parts[0]!.text).toContain("新しい指示");

    // goAway → reconnect with a fresh token / socket
    ws.receive({ goAway: { timeLeft: "10s" } });
    await ws.flush();
    await ws.flush();
    expect(FakeWS.instances.length).toBe(2);
    expect(events.filter((e) => e.type === "session_ready").length).toBe(2);
    await p.disconnect();
  });

  it("refuses to connect under strict_local and surfaces broker BLOCKED errors", async () => {
    const p = new GeminiLiveProvider({ brokerUrl: "http://b", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u) });
    await expect(p.connect({ ...config, privacyMode: "strict_local" })).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(FakeWS.instances.length).toBe(0);
    const blocked = new GeminiLiveProvider({
      brokerUrl: "http://b",
      wsFactory: (u) => new FakeWS(u),
      fetchImpl: (async () => new Response(JSON.stringify({ error: "BLOCKED_BY_GEMINI_KEY" }), { status: 503 })) as unknown as typeof fetch,
    });
    await expect(blocked.connect(config)).rejects.toThrow("BLOCKED_BY_GEMINI_KEY");
  });

  it("evaluation provider posts to the broker and respects strict_local", async () => {
    const ev = createGeminiEvaluationProvider({ brokerUrl: "http://localhost:8787", fetchImpl: tokenFetch });
    const input = { mode: "interview", language: "ja-JP", transcript: [], timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] }, interruptions: { byUser: 0, byAssistant: 0 } };
    const r = await ev.evaluate(input);
    expect(r.overall).toBe(80);
    expect(r.evaluatedBy).toBe("google");
    const strict = createGeminiEvaluationProvider({ brokerUrl: "http://localhost:8787", fetchImpl: tokenFetch, privacyMode: "strict_local" });
    await expect(strict.evaluate(input)).rejects.toBeInstanceOf(PrivacyViolationError);
  });
});

describe("GeminiLiveProvider reconnection", () => {
  it("reconnects with backoff after an abnormal close and resumes with the session handle", async () => {
    const { p, ws, events } = await connected({ reconnectBackoffMs: 100 });
    ws.receive({ sessionResumptionUpdate: { resumable: true, newHandle: "h-1" } });
    await ws.flush();
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 100)) } }] } } });
    await ws.flush();
    const before = FakeWS.instances.length;
    ws.onclose?.({ code: 1006, reason: "network" }); // abnormal close, not initiated by us
    await ws.flush();
    expect(events.map((e) => e.type)).toContain("interrupted");
    expect(FakeWS.instances.length).toBe(before); // waits for the backoff first
    await vi.advanceTimersByTimeAsync(120);
    await ws.flush();
    expect(FakeWS.instances.length).toBe(before + 1);
    const ws2 = FakeWS.instances[FakeWS.instances.length - 1]!;
    await ws2.flush();
    const setup = ws2.sent.find((m) => "setup" in m) as { setup: { sessionResumption?: { handle: string } } };
    expect(setup.setup.sessionResumption?.handle).toBe("h-1");
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "session_ready").length).toBe(2);
    expect(types).not.toContain("session_closed");
    expect(p.diagnostics.reconnects).toBe(1);
    // Audio flows on the new socket.
    for (let i = 0; i < 10; i++) p.pushAudio(createFrame(sine(48000, 20), 48000, i * 20));
    expect(ws2.sent.some((m) => "realtimeInput" in m)).toBe(true);
    await p.disconnect();
  });

  it("clean close (1000) is reported as session_closed without reconnecting", async () => {
    const { ws, events } = await connected();
    const before = FakeWS.instances.length;
    ws.onclose?.({ code: 1000, reason: "bye" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWS.instances.length).toBe(before);
    expect(events[events.length - 1]).toEqual({ type: "session_closed", reason: "bye" });
  });

  it("gives up after maxReconnects with a fatal error", async () => {
    let failTokens = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => (failTokens && url.endsWith("/api/token/gemini") ? new Response(JSON.stringify({ error: "down" }), { status: 503 }) : tokenFetch(url, init))) as unknown as typeof fetch;
    const { p, ws, events } = await connected({ fetchImpl, reconnectBackoffMs: 10, maxReconnects: 2 });
    failTokens = true;
    ws.onclose?.({ code: 1011, reason: "server error" });
    await vi.advanceTimersByTimeAsync(500);
    await ws.flush();
    const errs = events.filter((e) => e.type === "error") as { fatal?: boolean }[];
    expect(errs[errs.length - 1]!.fatal).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "session_closed", reason: "reconnect exhausted" });
    expect(p.diagnostics.reconnectFailures).toBe(2);
  });
});

describe("setup per model family", () => {
  it("keeps affective dialog and language auto-detection for native audio only", () => {
    const p = new GeminiLiveProvider({ brokerUrl: "http://b" });
    const native = p.buildSetup("gemini-2.5-flash-native-audio-preview-12-2025", config);
    expect(native.generationConfig?.enableAffectiveDialog).toBe(true);
    expect(native.generationConfig?.speechConfig?.languageCode).toBeUndefined();

    const live = p.buildSetup("gemini-3.1-flash-live-preview", config);
    expect(live.generationConfig?.enableAffectiveDialog).toBeUndefined();
    expect(live.generationConfig?.speechConfig?.languageCode).toBe("ja-JP");
  });
});

describe("the operator pins the native-audio model", () => {
  /**
   * Native audio costs 3–5× the latency of flash-live. The only thing that buys is reacting to how
   * something was said — so it must be on by default there, and an app that has not asked for it must
   * not switch it off.
   */
  it("keeps affective dialog on when the app says nothing about it", async () => {
    const p = new GeminiLiveProvider({ brokerUrl: "http://b", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u), model: "gemini-2.5-flash-native-audio-latest" });
    await p.connect(config);
    const setup = (FakeWS.instances[0]!.sent[0] as { setup: ReturnType<GeminiLiveProvider["buildSetup"]> }).setup;
    expect(setup.generationConfig?.enableAffectiveDialog).toBe(true);
  });

  it("still lets it be turned off deliberately", async () => {
    const p = new GeminiLiveProvider({ brokerUrl: "http://b", fetchImpl: tokenFetch, wsFactory: (u) => new FakeWS(u), model: "gemini-2.5-flash-native-audio-latest", enableAffectiveDialog: false });
    await p.connect(config);
    const setup = (FakeWS.instances[0]!.sent[0] as { setup: ReturnType<GeminiLiveProvider["buildSetup"]> }).setup;
    expect(setup.generationConfig?.enableAffectiveDialog).toBeUndefined();
  });

describe("the Live setup a meeting asks for", () => {
  const setup = (opts = {}, config = {}) =>
    new GeminiLiveProvider({ brokerUrl: "http://localhost:8787", ...opts }).buildSetup(
      (opts as { model?: string }).model ?? DEFAULT_GEMINI_LIVE_MODEL,
      { systemPrompt: "あなたは会議のYuiです。", mode: "free_talk", language: "ja-JP", privacyMode: "default", ...config } as never,
    );

  it("asks 3.1 Flash Live for minimal thinking and Kore, and says so rather than trusting a default", () => {
    const s = setup();
    expect(s.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(s.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(s.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Kore");
    expect(s.generationConfig?.responseModalities).toEqual(["AUDIO"]);
  });

  it("lets the character's own voice and another thinking level through, and can send neither", () => {
    expect(setup({ defaultVoice: "Schedar" }).generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Schedar");
    expect(setup({}, { voice: "Iapetus" }).generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Iapetus");
    expect(setup({ thinkingLevel: "standard" }).generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "standard" });
    expect(setup({ thinkingLevel: "off" }).generationConfig?.thinkingConfig).toBeUndefined();
  });

  it("keeps the Japanese conversation rules in the system instruction", () => {
    const text = setup().systemInstruction?.parts?.[0]?.text ?? "";
    expect(text).toContain("あなたは会議のYuiです。");
    expect(text).toContain("返答は原則1〜3文");
    expect(text).toContain("ユーザーが話している途中では割り込まない");
    expect(text).toContain("必ず日本語（ja-JP）で");
  });
});

});

describe("what a turn is timed on", () => {
  it("reports first audio from speech end, and keeps turnComplete out of the latency", async () => {
    const { p, ws, events } = await connected();
    // The room stopped talking 900 ms ago …
    (p as unknown as { timing: { userSpeechEndAt: number; source: string } }).timing.userSpeechEndAt = Date.now() - 900;
    // … and the first sound of the reply arrives now, with more to come.
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 1000)) } }] } } });
    await ws.flush();
    ws.receive({ serverContent: { turnComplete: true } });
    await ws.flush();
    const m = events.find((e) => e.type === "metrics") as { turn: { firstAudioSentMs?: number; totalMs?: number; source?: string } } | undefined;
    expect(m).toBeDefined();
    expect(m!.turn.firstAudioSentMs).toBeGreaterThanOrEqual(850);
    expect(m!.turn.firstAudioSentMs).toBeLessThan(1200);
    expect(m!.turn.totalMs).toBeGreaterThanOrEqual(m!.turn.firstAudioSentMs!); // the reply's own length, not latency
    expect(m!.turn.source).toBe("speech");
    await p.disconnect();
  });

describe("what the API is charged for", () => {
  it("sends the room's silence to nobody, and can be told to stream everything", async () => {
    const quietFrames = 40;
    const run = async (extra = {}) => {
      const { p, ws } = await connected(extra);
      let ts = 0;
      for (let i = 0; i < quietFrames; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
      const inputs = () => ws.sent.filter((m) => "realtimeInput" in m) as { realtimeInput: { audio?: unknown } }[];
      const audio = inputs().filter((m) => m.realtimeInput.audio).length;
      await p.disconnect();
      return audio;
    };
    expect(await run()).toBe(0); // 800 ms of silence: nothing sent, nothing billed
    expect(await run({ gateAudioOnSpeech: false })).toBe(quietFrames); // the old continuous stream, on request
  });
});
});
