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
    expect(setup.realtimeInputConfig?.turnCoverage).toBe("TURN_INCLUDES_ONLY_ACTIVITY");
    expect(setup.contextWindowCompression).toEqual({ triggerTokens: "10000", slidingWindow: { targetTokens: "3000" } });
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
    const declared = setup.tools?.find((t) => "functionDeclarations" in t);
    expect(declared && "functionDeclarations" in declared ? declared.functionDeclarations[0]?.name : null).toBe("lookup");
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
    // Audio flows on the new socket. Long enough to cover the VAD's calibration, which starts again
    // with the new session: the first 400 ms of any room sets the floor rather than opening a turn.
    for (let i = 0; i < 40; i++) p.pushAudio(createFrame(sine(48000, 20), 48000, i * 20));
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

  it("asks 3.1 Flash Live for minimal thinking and the friendly voice, and says so rather than trusting a default", () => {
    const s = setup();
    expect(s.model).toBe("models/gemini-3.1-flash-live-preview");
    expect(s.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    // "Firm" is the wrong first impression for a character; the default is "Friendly" and the pack
    // or the setting may still name any of the others.
    expect(s.generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Achird");
    expect(setup({}, { voice: "Leda" }).generationConfig?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Leda");
    expect(s.generationConfig?.responseModalities).toEqual(["AUDIO"]);
  });

  /**
   * Asked for the news, a character that cannot look anything up can only say so — and did, to the
   * same person twice in one day. The Live API grounds its own answer when the tool is declared.
   */
  it("declares Google Search where the model takes it, and not where it closes the session", () => {
    // 3.1 Flash Live refuses the socket outright when the tool is declared (1011, "exceeded your
    // current quota") while the same key grounds happily on native audio and answers with the day's
    // actual news. So it is asked for where it works, and forced only on request.
    expect(setup().tools).toBeUndefined();
    const native = setup({ model: "gemini-2.5-flash-preview-native-audio-dialog" });
    expect(native.tools).toEqual([{ googleSearch: {} }]);
    const declared = setup({ model: "gemini-2.5-flash-preview-native-audio-dialog" }, { tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    expect(declared.tools).toHaveLength(1);
    expect(declared.tools?.[0]).toHaveProperty('functionDeclarations');
    expect(setup({ googleSearch: true }).tools).toEqual([{ googleSearch: {} }]);
    expect(setup({ model: "gemini-2.5-flash-preview-native-audio-dialog", googleSearch: false }).tools).toBeUndefined();
    const withFn = setup({ googleSearch: true }, { tools: [{ name: "lookup", description: "d", parameters: { type: "object" } }] });
    expect(withFn.tools).toHaveLength(2);
    expect(withFn.tools?.[1]).toEqual({ googleSearch: {} });
  });

  it("reports the capability the way the session is actually configured", () => {
    const on = new GeminiLiveProvider({ brokerUrl: "http://b", model: "gemini-2.5-flash-preview-native-audio-dialog" });
    const off = new GeminiLiveProvider({ brokerUrl: "http://b" });
    expect(on.capabilities().extras?.search).toBe(true);
    expect(off.capabilities().extras?.search).toBe(false);
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
  it("labels metrics with the broker-selected model", async () => {
    const selected = "gemini-live-2.5-flash-native-audio";
    const { p, ws, events } = await connected({ fetchImpl: (async () => new Response(JSON.stringify({ token: "test", model: selected }))) as typeof fetch });
    (p as unknown as { timing: { userSpeechEndAt: number } }).timing.userSpeechEndAt = Date.now() - 500;
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 100)) } }] }, turnComplete: true } });
    await ws.flush();
    const metric = events.find(e => e.type === "metrics");
    expect(metric?.type === "metrics" && metric.turn.engines?.llm).toBe(selected);
    await p.disconnect();
  });

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
    const quietFrames = 3000;
    const run = async (extra = {}) => {
      const { p, ws } = await connected(extra);
      let ts = 0;
      for (let i = 0; i < quietFrames; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
      const inputs = () => ws.sent.filter((m) => "realtimeInput" in m) as { realtimeInput: { audio?: unknown } }[];
      const audio = inputs().filter((m) => m.realtimeInput.audio).length;
      expect(p.usageSnapshot().inputAudioSeconds).toBeCloseTo(audio * .02, 4);
      await p.disconnect();
      return audio;
    };
    expect(await run()).toBe(0); // 60 seconds of synthetic silence: no input audio sent (not an invoice assertion)
    expect(await run({ gateAudioOnSpeech: false })).toBe(quietFrames); // the old continuous stream, on request
  });
});

describe("the gate's fallback", () => {
  it("keeps a clause pause inside a turn, then closes sustained silence at 500 ms", async () => {
    const { p, ws } = await connected();
    let ts = 0;
    const quiet = (ms: number) => {
      for (let i = 0; i < ms / 20; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    };
    const speech = () => {
      for (let i = 0; i < 20; i++) { p.pushAudio(createFrame(sine(48000, 20), 48000, ts)); ts += 20; }
    };
    const ends = () => ws.sent.filter((m) => (m as { realtimeInput?: { activityEnd?: unknown } }).realtimeInput?.activityEnd !== undefined).length;
    quiet(600);
    speech();
    quiet(360);
    expect(ends()).toBe(0);
    speech();
    quiet(480);
    expect(ends()).toBe(0);
    quiet(40);
    expect(ends()).toBe(1);
    await p.disconnect();
  });

  it("opens on sound the adaptive VAD refuses to call speech (2026-09-07: 2437 frames, 0 transcripts)", async () => {
    const { p, ws } = await connected();
    let ts = 0;
    // A room that is never quiet: the VAD's noise floor climbs to meet it and nothing ever clears
    // floor + 12 dB, so speech_start never fires. The level is plainly somebody talking.
    for (let i = 0; i < 120; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.3), 48000, ts)); ts += 20; }
    const inputs = ws.sent.filter((m) => "realtimeInput" in m) as { realtimeInput: { audio?: unknown; activityStart?: unknown } }[];
    expect(inputs.filter((m) => m.realtimeInput.activityStart).length).toBe(1);
    expect(inputs.filter((m) => m.realtimeInput.audio).length).toBeGreaterThan(50);
    expect(p.gateStats.sent).toBeGreaterThan(50);
    await p.disconnect();
  });

  /**
   * The fallback's own regression. An absolute -45 dBFS bar reads a meeting stream with automatic
   * gain as "loud" even in its silences, so the gate opened on the room's hiss and never closed: the
   * model was never told the turn ended, transcribed every word and answered none (2026-09-07,
   * one-to-one on Gemini: 48 transcripts, 0 replies). A turn that has been forced shut stays shut
   * while the room is still loud — and the room going quiet is what lets the next one open.
   */
  it("stops paying for a room that never goes quiet, and reopens when it does", async () => {
    // Keep the fallback meter loud even if adaptive VAD classifies the steady tone as noise.
    const { p, ws } = await connected();
    vi.spyOn((p as unknown as { vad: { readonly noiseFloor: number } }).vad, "noiseFloor", "get").mockReturnValue(-60);
    let ts = 0;
    const push = (amp: number, n: number) => { for (let i = 0; i < n; i++) { p.pushAudio(createFrame(amp > 0.01 ? sine(48000, 20, amp) : new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; } };
    push(0.3, 6500); // 130 seconds of unbroken sound: bounded at two minutes
    const audioSent = () => ws.sent.filter((m) => "realtimeInput" in m && (m as { realtimeInput: { audio?: unknown } }).realtimeInput.audio).length;
    const paidFor = audioSent();
    push(0.3, 200); // still loud: not one more chunk is bought
    expect(audioSent()).toBe(paidFor);
    push(0, 60); // the room finally goes quiet
    push(0.3, 40); // and someone speaks again
    const starts = ws.sent.filter((m) => "realtimeInput" in m && (m as { realtimeInput: { activityStart?: unknown } }).realtimeInput.activityStart).length;
    expect(starts).toBe(2);
    expect(audioSent()).toBeGreaterThan(paidFor);
    await p.disconnect();
  });

  it("keeps a long spoken request open past eight seconds and closes after the speaker stops", async () => {
    const { p, ws } = await connected();
    let ts = 0;
    for (let i = 0; i < 60; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    for (let i = 0; i < 600; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.03 + 0.27 * (Math.sin(i / 10) + 1) / 2), 48000, ts)); ts += 20; }
    const ends = () => ws.sent.filter((m) => "realtimeInput" in m && (m as { realtimeInput: { activityEnd?: unknown } }).realtimeInput.activityEnd);
    expect(p.gateStats.forced).toBe(0);
    expect(ends()).toHaveLength(0);
    for (let i = 0; i < 60; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    expect(ends()).toHaveLength(1);
    expect(p.gateStats.forced).toBe(0);
    await p.disconnect();
  });

  it("ends a turn that never ends, so the model always gets a boundary to answer at", async () => {
    // Keep the fallback meter loud even if adaptive VAD classifies the steady tone as noise.
    const { p, ws } = await connected();
    vi.spyOn((p as unknown as { vad: { readonly noiseFloor: number } }).vad, "noiseFloor", "get").mockReturnValue(-60);
    let ts = 0;
    // More than two minutes of unbroken sound: the meters never agree that the room stopped.
    for (let i = 0; i < 6500; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.3), 48000, ts)); ts += 20; }
    const inputs = ws.sent.filter((m) => "realtimeInput" in m) as { realtimeInput: { activityStart?: unknown; activityEnd?: unknown } }[];
    expect(p.gateStats.forced).toBeGreaterThanOrEqual(1);
    expect(inputs.filter((m) => m.realtimeInput.activityEnd).length).toBeGreaterThanOrEqual(1);
    // Closed once and left closed: a loud room must not reopen the turn on the next frame.
    expect(inputs.filter((m) => m.realtimeInput.activityStart).length).toBe(1);
    await p.disconnect();
  });
});

/**
 * The words have to reach the page while they still matter. Delivered with `turnComplete` — the end
 * of the model's own reply — the transcript arrives after everything that needed it has decided.
 */
describe("the first second of a session", () => {
  /**
   * The VAD's floor starts at -60 dBFS and has to hear the room before it knows what quiet is. Until
   * it does, the level fallback would open a turn on the room's own hiss and hand the model a second
   * of nothing to answer — six seconds of silence drew a reply on the P0 gate (07 Sep).
   */
  it("belongs to the room: only the VAD may open a turn while the floor is still being learnt", async () => {
    const { p, ws } = await connected();
    let ts = 0;
    // Room tone that clears the fallback's bar but is nobody speaking.
    for (let i = 0; i < 50; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.01), 48000, ts)); ts += 20; }
    expect(ws.sent.filter((m) => "realtimeInput" in m)).toHaveLength(0);
    // Someone actually speaking in that first second is still heard: the VAD opens it.
    for (let i = 0; i < 10; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.4), 48000, ts)); ts += 20; }
    expect(ws.sent.filter((m) => "realtimeInput" in m && (m as { realtimeInput: { activityStart?: unknown } }).realtimeInput.activityStart)).toHaveLength(1);
    await p.disconnect();
  });
});

describe("when the user's words are delivered", () => {
  it("keeps a late address suffix in the same utterance before reply audio", async () => {
    const { p, ws, events } = await connected();
    let ts = 0;
    for (let i = 0; i < 10; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    for (let i = 0; i < 20; i++) { p.pushAudio(createFrame(sine(48000, 20), 48000, ts)); ts += 20; }
    ws.receive({ serverContent: { inputTranscription: { text: "ゆ" } } });
    await ws.flush();
    for (let i = 0; i < 60; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    const first = events.find(e => e.type === "user_transcript" && e.final === true);
    expect(first).toMatchObject({ text: "ゆ", final: true });
    ws.receive({ serverContent: { inputTranscription: { text: "い、その予定は何時に終わりますか。" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(new Float32Array(240).fill(0.1)) } }] } } });
    await ws.flush();
    const revisions = events.filter(e => e.type === "user_transcript_revised");
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ id: (first as { id: number }).id, text: "ゆい、その予定は何時に終わりますか。" });
    expect(events.indexOf(revisions[0]!)).toBeLessThan(events.findIndex(e => e.type === "assistant_speech_started"));
    ws.receive({ serverContent: { turnComplete: true } });
    await ws.flush();
    expect(events.filter(e => e.type === "user_transcript" && e.final === true)).toHaveLength(1);
    ws.receive({ serverContent: { inputTranscription: { text: "次の質問です。" }, turnComplete: true } });
    await ws.flush();
    const next = events.filter(e => e.type === "user_transcript" && e.final === true).at(-1);
    expect(next).toMatchObject({ text: "次の質問です。" });
    expect((next as { id: number }).id).not.toBe((first as { id: number }).id);
    await p.disconnect();
  });

  it("is when the user stops talking, not when the model finishes answering", async () => {
    const { p, ws, events } = await connected();
    let ts = 0;
    for (let i = 0; i < 10; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    for (let i = 0; i < 20; i++) { p.pushAudio(createFrame(sine(48000, 20), 48000, ts)); ts += 20; }
    ws.receive({ serverContent: { inputTranscription: { text: "今日の資料" } } });
    ws.receive({ serverContent: { inputTranscription: { text: "見てくれた？" } } });
    await ws.flush();
    expect(events.filter((e) => e.type === "user_transcript" && e.final === true)).toHaveLength(0);
    // The room goes quiet: our gate closes the turn, and the words go with it.
    for (let i = 0; i < 60; i++) { p.pushAudio(createFrame(new Float32Array(960).fill(0.0005), 48000, ts)); ts += 20; }
    const finals = events.filter((e) => e.type === "user_transcript" && e.final === true) as { text: string }[];
    expect(finals).toHaveLength(1);
    expect(finals[0]!.text).toBe("今日の資料見てくれた？");
    // And it is not said twice when the model's own turn completes.
    ws.receive({ serverContent: { turnComplete: true } });
    await ws.flush();
    expect(events.filter((e) => e.type === "user_transcript" && e.final === true)).toHaveLength(1);
    await p.disconnect();
  });
});

describe("the call must not howl", () => {
  it("holds the room's return path while the character speaks, and lets a real barge-in through", async () => {
    const { p, ws, events } = await connected();
    // She starts speaking: a second of audio comes back from the model.
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 1000)) } }] } } });
    await ws.flush();
    const before = ws.sent.filter((m) => "realtimeInput" in m).length;
    // Her own voice returning through a speaker into the microphone next to it: loud enough for the
    // gate's fallback, not loud enough to be someone talking over her. Past the gate's warm-up, so the
    // room's floor is learnt and the fallback is live.
    let ts = 2000;
    for (let i = 0; i < 30; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.02), 48000, ts)); ts += 20; }
    expect(ws.sent.filter((m) => "realtimeInput" in m).length).toBe(before); // nothing sent back to the model
    expect(p.gateStats.held).toBeGreaterThan(0);
    // Her reply stops the moment somebody talks over her, without waiting for the model to notice.
    expect(events.filter((e) => e.type === "interrupted")).toHaveLength(0);
    for (let i = 0; i < 12; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.5), 48000, ts)); ts += 20; }
    expect(events.filter((e) => e.type === "interrupted").length).toBeGreaterThanOrEqual(1);
    expect(p.gateStats.bargeIns).toBeGreaterThanOrEqual(1);
    // The tail of the cut reply keeps arriving from the server; none of it reaches the host.
    const audioBefore = events.filter((e) => e.type === "assistant_audio").length;
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 200)) } }] } } });
    await ws.flush();
    expect(events.filter((e) => e.type === "assistant_audio")).toHaveLength(audioBefore);
    // The server's own "interrupted" is an acknowledgement, not the end of the tail.
    ws.receive({ serverContent: { interrupted: true } });
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 200)) } }] } } });
    await ws.flush();
    expect(events.filter((e) => e.type === "assistant_audio")).toHaveLength(audioBefore);
    // Once a turn has ended, the next reply plays normally.
    ws.receive({ serverContent: { turnComplete: true } });
    ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 200)) } }] } } });
    await ws.flush();
    expect(events.filter((e) => e.type === "assistant_audio").length).toBeGreaterThan(audioBefore);
    // Someone actually talking over her does get through.
    for (let i = 0; i < 30; i++) { p.pushAudio(createFrame(sine(48000, 20, 0.5), 48000, ts)); ts += 20; }
    expect(ws.sent.filter((m) => "realtimeInput" in m).length).toBeGreaterThan(before);
    await p.disconnect();
  });
});
});

it("does not promote cancelled transcript fragments into a new runtime generation", async () => {
  const { ConversationRuntime } = await import("@rcai/conversation-core");
  const provider = new GeminiLiveProvider({ brokerUrl: "http://localhost:8787/", fetchImpl: tokenFetch, wsFactory: (url) => new FakeWS(url) });
  const runtime = new ConversationRuntime({ localVad: false });
  const events: ConversationEvent[] = [];
  runtime.on((event) => events.push(event));
  await runtime.start(provider, config);
  const ws = FakeWS.instances.at(-1)!;
  const audio = { inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 200)) } };
  ws.receive({ serverContent: { modelTurn: { parts: [audio] }, outputTranscription: { text: "接続できました。" } } });
  await ws.flush();
  await runtime.interrupt();
  const afterInterrupt = events.length;

  // Production reproduction: output transcriptions arrive in packets without modelTurn/audio.
  ws.receive({ serverContent: { outputTranscription: { text: "いつでも" } } });
  ws.receive({ serverContent: { interrupted: true } });
  ws.receive({ serverContent: { outputTranscription: { text: "お声かけくださいね。" } } });
  ws.receive({ serverContent: { outputTranscription: { text: "旧末尾" }, turnComplete: true } });
  await ws.flush();
  vi.advanceTimersByTime(500);
  expect(events.slice(afterInterrupt).filter((event) => event.type.startsWith("assistant_"))).toEqual([]);
  expect(runtime.getRecord().turns.filter((turn) => turn.role === "assistant").map((turn) => turn.text)).toEqual(["接続できました。"]);

  await runtime.sendText("次の質問です。");
  ws.receive({ serverContent: { outputTranscription: { text: "新しい返答です。" }, modelTurn: { parts: [audio] }, turnComplete: true } });
  await ws.flush();
  vi.advanceTimersByTime(500);
  expect(events.flatMap((event) => event.type === "assistant_transcript" && event.final ? [event.text] : [])).toEqual(["新しい返答です。"]);
  expect(events.filter((event) => event.type === "assistant_audio").map((event) => event.gen?.generationId)).toEqual([1, 2]);
  await runtime.stop();
});

it("consumes the cancelled turn boundary even when its final packet still contains audio and text", async () => {
  const { p, ws, events } = await connected();
  const audio = { inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 200)) } };
  ws.receive({ serverContent: { modelTurn: { parts: [audio] } } });
  await ws.flush();
  await p.interrupt();
  const afterInterrupt = events.length;
  ws.receive({ serverContent: { modelTurn: { parts: [audio, { text: "旧本文" }] }, outputTranscription: { text: "旧字幕" }, turnComplete: true } });
  await ws.flush();
  expect(events.slice(afterInterrupt).filter((event) => event.type.startsWith("assistant_"))).toEqual([]);

  // The completed cancellation must not keep the next genuine model turn gated shut.
  ws.receive({ serverContent: { modelTurn: { parts: [audio] }, outputTranscription: { text: "次の返答" }, turnComplete: true } });
  await ws.flush();
  expect(events.filter((event) => event.type === "assistant_audio").map((event) => event.gen?.generationId)).toEqual([1, 2]);
  expect(events.flatMap((event) => event.type === "assistant_transcript" && event.final ? [event.text] : [])).toEqual(["次の返答"]);
  await p.disconnect();
});

it('delivers a tool-first reply after interruption while dropping cancelled tool calls',async()=>{
 const {ConversationRuntime}=await import('@rcai/conversation-core');
 const p=new GeminiLiveProvider({brokerUrl:'http://localhost:8787/',fetchImpl:tokenFetch,wsFactory:u=>new FakeWS(u)});
 const runtime=new ConversationRuntime({localVad:false});
 const calls:string[]=[];
 runtime.on(e=>{if(e.type==='tool_call'){calls.push(e.call.id!);runtime.sendToolResponse([{id:e.call.id,name:e.call.name,response:{ok:true}}]);}});
 await runtime.start(p,config);const ws=FakeWS.instances.at(-1)!;
 ws.receive({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:float32ToBase64Pcm16(sine(24000,200))}}]}}});await ws.flush();
 await runtime.interrupt();
 ws.receive({toolCall:{functionCalls:[{id:'cancelled',name:'session_tasks',args:{operations:[]}}]}});await ws.flush();
 expect(calls).toEqual([]);
 // No model audio precedes the next function request; this must open the next generation itself.
 await runtime.sendText('残りを教えて');
 ws.receive({toolCall:{functionCalls:[{id:'fresh',name:'session_tasks',args:{operations:[]}}]}});await ws.flush();
 expect(calls).toEqual(['fresh']);
 expect(ws.sent.some(m=>JSON.stringify(m).includes('"functionResponses":[{"id":"fresh"'))).toBe(true);
 await runtime.stop();
});
it('does not cut an already open user utterance when assistant audio overlaps a quiet syllable',async()=>{
 const {p,ws,events}=await connected();
 let ts=2000;
 for(let i=0;i<60;i++){p.pushAudio(createFrame(new Float32Array(960),48000,ts));ts+=20;}
 for(let i=0;i<20;i++){p.pushAudio(createFrame(sine(48000,20,.5),48000,ts));ts+=20;}
 expect(p.gateStats.opens).toBeGreaterThan(0);
 ws.receive({serverContent:{modelTurn:{parts:[{inlineData:{mimeType:'audio/pcm;rate=24000',data:float32ToBase64Pcm16(sine(24000,1000))}}]}}});await ws.flush();
 const before=p.gateStats.sent,closes=p.gateStats.closes;
 for(let i=0;i<10;i++){p.pushAudio(createFrame(sine(48000,20,.02),48000,ts));ts+=20;}
 expect(p.gateStats.sent).toBeGreaterThan(before);
 expect(p.gateStats.closes).toBe(closes);
 expect(p.gateStats.bargeIns).toBe(0);
 expect(events.some(e=>e.type==='interrupted')).toBe(false);
 await p.disconnect();
});
it('keeps a default retry available after a ten-second outage and cancels it on leave',async()=>{
 let offline=false;
 const fetchImpl=(async(url:string,init?:RequestInit)=>{if(offline)throw new Error('offline');return tokenFetch(url,init);}) as typeof fetch;
 const {p,ws,events}=await connected({fetchImpl});
 offline=true;ws.onclose?.({code:1006});await vi.advanceTimersByTimeAsync(10000);
 expect(events.some(e=>e.type==='session_closed')).toBe(false);
 expect(p.diagnostics.reconnectFailures).toBe(3);
 offline=false;await vi.advanceTimersByTimeAsync(5000);
 expect(events.filter(e=>e.type==='session_ready')).toHaveLength(2);
 const latest=FakeWS.instances.at(-1)!;
 offline=true;latest.onclose?.({code:1006});await vi.advanceTimersByTimeAsync(1000);
 await p.disconnect();const count=FakeWS.instances.length;
 offline=false;await vi.advanceTimersByTimeAsync(30000);
 expect(FakeWS.instances.length).toBe(count);
});


it("preserves a quiet word onset before a louder interruption without transmitting the held return path", async () => {
  const { p, ws } = await connected();
  let ts = 2000;
  for (let i = 0; i < 60; i++) { p.pushAudio(createFrame(new Float32Array(960), 48000, ts)); ts += 20; }
  ws.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: float32ToBase64Pcm16(sine(24000, 1000)) } }] } } });
  await ws.flush();
  const audio = () => ws.sent.flatMap((m) => {
    const input = m.realtimeInput as { audio?: { data: string } } | undefined;
    return input?.audio ? [input.audio.data] : [];
  });
  const before = audio().length;
  for (let i = 0; i < 30; i++) { p.pushAudio(createFrame(sine(48000, 20, .02), 48000, ts)); ts += 20; }
  expect(audio()).toHaveLength(before);
  p.pushAudio(createFrame(sine(48000, 20, .5), 48000, ts));
  const sent = audio().slice(before);
  // The 300 ms prefix must precede the louder syllable, but cannot grow with time spent muted.
  expect(sent.length).toBeGreaterThan(1);
  expect(sent.length).toBeLessThanOrEqual(16);
  const samples = (b64: string) => { const b = Buffer.from(b64, "base64"); return Array.from({ length: b.length / 2 }, (_, i) => Math.abs(b.readInt16LE(i * 2)) / 32768); };
  expect(Math.max(...samples(sent[0]!))).toBeLessThan(.03);
  expect(Math.max(...samples(sent.at(-1)!))).toBeGreaterThan(.1);
  await p.disconnect();
});
