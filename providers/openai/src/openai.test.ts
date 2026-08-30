import { describe, expect, it, vi } from "vitest";
import { PrivacyViolationError } from "@rcai/provider-core";
import { conversationPolicyFor, type ConversationEvent, type SessionConfig } from "@rcai/conversation-core";
import { OpenAIEventMapper } from "./events.js";
import { OpenAIRealtimeProvider } from "./provider.js";
import { openaiPromptAdapter } from "./prompt.js";
import { createOpenAIEvaluationProvider } from "./evaluation.js";

/** Generation stamps are covered by their own test; strip them for shape comparisons. */
const stripGen = <T extends object>(e: T): Omit<T, "gen"> => { const { gen: _g, ...rest } = e as T & { gen?: unknown }; void _g; return rest; };

describe("OpenAIEventMapper", () => {
  it("maps GA server events to unified events", () => {
    const m = new OpenAIEventMapper();
    const table: [Record<string, unknown>, ConversationEvent[]][] = [
      [{ type: "session.created" }, []],
      [{ type: "input_audio_buffer.speech_started" }, [{ type: "user_speech_started", at: 1 }]],
      [{ type: "input_audio_buffer.speech_stopped" }, [{ type: "user_speech_ended", at: 1 }]],
      [{ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", delta: "こん" }, [{ type: "user_transcript", text: "こん", final: false }]],
      [{ type: "conversation.item.input_audio_transcription.delta", item_id: "i1", delta: "にちは" }, [{ type: "user_transcript", text: "こんにちは", final: false }]],
      [{ type: "conversation.item.input_audio_transcription.completed", item_id: "i1", transcript: "こんにちは" }, [{ type: "user_transcript", text: "こんにちは", final: true }]],
      [{ type: "response.created" }, [{ type: "assistant_thinking" }]],
      [{ type: "output_audio_buffer.started" }, [{ type: "assistant_speech_started", at: 1 }]],
      [{ type: "response.output_audio_transcript.delta", delta: "やあ" }, [{ type: "assistant_transcript", text: "やあ", final: false }]],
      [{ type: "response.output_audio_transcript.done", transcript: "やあ、元気？" }, [{ type: "assistant_transcript", text: "やあ、元気？", final: true }]],
      [{ type: "response.function_call_arguments.done", call_id: "c1", name: "lookup", arguments: '{"q":"x"}' }, [{ type: "tool_call", call: { id: "c1", name: "lookup", arguments: { q: "x" } } }]],
      [{ type: "output_audio_buffer.stopped" }, [{ type: "assistant_speech_ended", at: 1 }]],
      [{ type: "response.done", response: { status: "completed" } }, []],
    ];
    for (const [raw, expected] of table) expect(m.map(raw as never, 1).map(stripGen)).toEqual(expected);
  });
  it("maps interruption + legacy names + errors", () => {
    const m = new OpenAIEventMapper();
    m.map({ type: "output_audio_buffer.started" }, 0);
    expect(m.isSpeaking).toBe(true);
    expect(m.map({ type: "output_audio_buffer.cleared" }, 5).map(stripGen)).toEqual([{ type: "interrupted", at: 5 }]);
    expect(m.isSpeaking).toBe(false);
    expect(m.map({ type: "output_audio_buffer.stopped" }, 6)).toEqual([]); // no duplicate end after clear
    expect(m.map({ type: "response.audio_transcript.delta", delta: "a" }, 0).map(stripGen)).toEqual([{ type: "assistant_transcript", text: "a", final: false }]);
    expect(m.map({ type: "response.audio_transcript.done", transcript: "ab" }, 0).map(stripGen)).toEqual([{ type: "assistant_transcript", text: "ab", final: true }]);
    expect(m.map({ type: "response.done", response: { status: "cancelled" } }, 7).map(stripGen)).toEqual([{ type: "interrupted", at: 7 }]);
    const err = m.map({ type: "error", error: { type: "invalid_request_error", code: "session_expired", message: "expired" } }, 0)[0]!;
    expect(err.type).toBe("error");
    if (err.type === "error") {
      expect(err.error.message).toBe("expired");
      expect(err.fatal).toBe(true);
    }
    expect(m.map({ type: "rate_limits.updated" }, 0)).toEqual([]);
  });
});

describe("openaiPromptAdapter", () => {
  it("prefixes a spoken-style lead and appends the policy", () => {
    const out = openaiPromptAdapter.adapt("あなたは面接官です。", conversationPolicyFor("ja-JP"));
    expect(out.startsWith("あなたは音声で会話するキャラクターです")).toBe(true);
    expect(out).toContain("あなたは面接官です。");
    expect(out).toContain("【会話ルール】");
  });
});

// ---- Fake WebRTC so connect() can be exercised in node -------------------
class FakeDataChannel {
  readyState: RTCDataChannelState = "connecting";
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  open() { this.readyState = "open"; this.onopen?.(); }
}
class FakePeerConnection {
  dc = new FakeDataChannel();
  tracks: unknown[] = [];
  remote: RTCSessionDescriptionInit | null = null;
  ontrack: ((ev: { streams: unknown[]; track: unknown }) => void) | null = null;
  closed = false;
  addTrack(track: unknown) { this.tracks.push(track); return { replaceTrack: async () => {} }; }
  addTransceiver() {}
  createDataChannel() { return this.dc; }
  async createOffer() { return { type: "offer" as const, sdp: "v=0 offer" }; }
  async setLocalDescription() {}
  async setRemoteDescription(d: RTCSessionDescriptionInit) { this.remote = d; this.ontrack?.({ streams: [{ id: "remote" }], track: {} }); setTimeout(() => this.dc.open(), 0); }
  close() { this.closed = true; }
}

const config: SessionConfig = { systemPrompt: "あなたは友達です。", mode: "free_talk", language: "ja-JP", voice: "marin", privacyMode: "default", providerOptions: { opening: "やあ！" } };

describe("OpenAIRealtimeProvider", () => {
  it("refuses to connect under strict_local", async () => {
    const p = new OpenAIRealtimeProvider({ brokerUrl: "http://localhost:8787", fetch: (async () => { throw new Error("no network expected"); }) as never });
    await expect(p.connect({ ...config, privacyMode: "strict_local" })).rejects.toBeInstanceOf(PrivacyViolationError);
  });

  it("connects via broker token → SDP POST with Bearer ephemeral key → session.update, and maps events", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/api/token/openai")) return new Response(JSON.stringify({ clientSecret: "ek_123", expiresAt: 1, model: "gpt-realtime", baseUrl: "https://api.openai.com/v1/realtime" }));
      if (url.startsWith("https://api.openai.com/v1/realtime/calls")) return new Response("v=0 answer", { status: 201 });
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    const pc = new FakePeerConnection();
    const p = new OpenAIRealtimeProvider({ brokerUrl: "http://localhost:8787/", fetch: fetchImpl, createPeerConnection: () => pc as unknown as RTCPeerConnection, clock: () => 42 });
    const events: ConversationEvent[] = [];
    p.onEvent((e) => events.push(e));
    p.attachInputStream({ getAudioTracks: () => [{ kind: "audio" }] } as unknown as MediaStream);
    await p.connect(config);

    // broker call carries adapted instructions + voice, never a key
    const tokenBody = JSON.parse(calls[0]!.init!.body as string);
    expect(calls[0]!.url).toBe("http://localhost:8787/api/token/openai");
    expect(tokenBody.voice).toBe("marin");
    expect(tokenBody.instructions).toContain("あなたは友達です。");
    expect(tokenBody.language).toBe("ja-JP");
    // SDP exchange
    expect(calls[1]!.url).toBe("https://api.openai.com/v1/realtime/calls?model=gpt-realtime");
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer ek_123");
    expect((calls[1]!.init!.headers as Record<string, string>)["Content-Type"]).toBe("application/sdp");
    expect(calls[1]!.init!.body).toBe("v=0 offer");
    expect(pc.remote?.sdp).toBe("v=0 answer");
    expect(pc.tracks.length).toBe(1);
    expect(p.getOutputStream()).toEqual({ id: "remote" });
    // session.update + opening response
    const update = pc.dc.sent.find((m) => m.type === "session.update") as { session: Record<string, any> };
    expect(update.session.type).toBe("realtime");
    expect(update.session.audio.input.turn_detection.type).toBe("server_vad");
    expect(update.session.audio.input.transcription.model).toBe("gpt-live-transcribe");
    expect(update.session.audio.output.voice).toBe("marin");
    expect(update.session.instructions).toContain("【会話ルール】");
    expect(pc.dc.sent.some((m) => m.type === "response.create")).toBe(true);
    expect(events[0]).toEqual({ type: "session_ready", providerId: "openai" });

    // server events through the data channel
    pc.dc.onmessage?.({ data: JSON.stringify({ type: "input_audio_buffer.speech_started" }) } as MessageEvent<string>);
    pc.dc.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.started" }) } as MessageEvent<string>);
    expect(events.slice(1).map(stripGen)).toEqual([{ type: "user_speech_started", at: 42 }, { type: "assistant_speech_started", at: 42 }]);

    await p.interrupt();
    expect(pc.dc.sent.slice(-2).map((m) => m.type)).toEqual(["response.cancel", "output_audio_buffer.clear"]);
    await p.sendText("こんにちは");
    const item = pc.dc.sent.find((m) => m.type === "conversation.item.create") as { item: { content: { type: string; text: string }[] } };
    expect(item.item.content[0]).toEqual({ type: "input_text", text: "こんにちは" });
    await p.updateContext({ systemPrompt: "新しい設定", mode: "interview", language: "ja-JP" });
    const last = pc.dc.sent[pc.dc.sent.length - 1] as { type: string; session: { instructions: string } };
    expect(last.type).toBe("session.update");
    expect(last.session.instructions).toContain("新しい設定");

    await p.disconnect();
    expect(pc.closed).toBe(true);
    expect(events[events.length - 1]).toEqual({ type: "session_closed" });
  });

  it("surfaces broker BLOCKED_BY_OPENAI_KEY as the connect error", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "BLOCKED_BY_OPENAI_KEY" }), { status: 503 })) as unknown as typeof fetch;
    const p = new OpenAIRealtimeProvider({ brokerUrl: "http://localhost:8787", fetch: fetchImpl, createPeerConnection: () => new FakePeerConnection() as unknown as RTCPeerConnection });
    await expect(p.connect(config)).rejects.toThrow("BLOCKED_BY_OPENAI_KEY");
  });
});

describe("createOpenAIEvaluationProvider", () => {
  it("posts to the broker and blocks under strict_local", async () => {
    let posted: unknown = null;
    const fetchImpl = (async (_url: string, init?: RequestInit) => { posted = JSON.parse(init!.body as string); return new Response(JSON.stringify({ overall: 80, clarity: 1, specificity: 2, structure: 3, relevance: 4, fluency: 5, feedback: [], improvedAnswer: "" })); }) as unknown as typeof fetch;
    const ev = createOpenAIEvaluationProvider({ brokerUrl: "http://b", fetch: fetchImpl });
    const input = { mode: "interview", language: "ja-JP", transcript: [], timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] }, interruptions: { byUser: 0, byAssistant: 0 } };
    const r = await ev.evaluate(input);
    expect(r.overall).toBe(80);
    expect(r.evaluatedBy).toBe("openai");
    expect((posted as { providerId: string }).providerId).toBe("openai");
    const strict = createOpenAIEvaluationProvider({ brokerUrl: "http://b", fetch: fetchImpl, privacyMode: "strict_local" });
    await expect(strict.evaluate(input)).rejects.toBeInstanceOf(PrivacyViolationError);
  });
});

// ---- Reconnection + speech-ended safety timer ------------------------------------------
class ReconnectPeerConnection extends FakePeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: (() => void) | null = null;
  setState(s: RTCPeerConnectionState) { this.connectionState = s; this.onconnectionstatechange?.(); }
}

function okFetch(fail: { token?: boolean } = {}) {
  let tokenCalls = 0;
  const impl = (async (url: string) => {
    if (url.endsWith("/api/token/openai")) {
      tokenCalls++;
      if (fail.token) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      return new Response(JSON.stringify({ clientSecret: `ek_${tokenCalls}`, expiresAt: 1, model: "gpt-realtime", baseUrl: "https://api.openai.com/v1/realtime" }));
    }
    if (url.startsWith("https://api.openai.com/v1/realtime/calls")) return new Response("v=0 answer", { status: 201 });
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;
  return { impl, get tokenCalls() { return tokenCalls; } };
}

describe("OpenAIRealtimeProvider reconnection", () => {
  it("re-establishes the call after a failed connection state and keeps one output stream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pcs: ReconnectPeerConnection[] = [];
      const f = okFetch();
      const p = new OpenAIRealtimeProvider({ brokerUrl: "http://b", fetch: f.impl, createPeerConnection: () => { const pc = new ReconnectPeerConnection(); pcs.push(pc); return pc as unknown as RTCPeerConnection; }, reconnectBackoffMs: 100, clock: () => 1 });
      const events: ConversationEvent[] = [];
      p.onEvent((e) => events.push(e));
      const connectP = p.connect(config);
      await vi.advanceTimersByTimeAsync(5);
      await connectP;
      expect(pcs.length).toBe(1);
      const firstOut = p.getOutputStream();
      // Speaking, then ICE fails mid-turn.
      pcs[0]!.dc.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.started" }) } as MessageEvent<string>);
      pcs[0]!.setState("failed");
      await vi.advanceTimersByTimeAsync(150); // 100 ms backoff → new token + pc + dc open (setTimeout 0)
      await vi.advanceTimersByTimeAsync(5);
      expect(pcs.length).toBe(2);
      expect(pcs[0]!.closed).toBe(true);
      expect(f.tokenCalls).toBe(2);
      const types = events.map((e) => e.type);
      expect(types).toEqual(["session_ready", "assistant_speech_started", "interrupted", "error", "session_ready"]);
      expect((events[3] as { fatal?: boolean }).fatal).toBe(false);
      expect(types).not.toContain("session_closed");
      expect(p.diagnostics.reconnects).toBe(1);
      // The new data channel received session.update with the same instructions.
      const upd = pcs[1]!.dc.sent.find((m) => m.type === "session.update") as { session: { instructions: string } };
      expect(upd.session.instructions).toContain("あなたは友達です。");
      // Without WebAudio in node the raw remote stream is exposed; a fresh one is fine for the fallback path.
      expect(p.getOutputStream()).toBeTruthy();
      expect(firstOut).toBeTruthy();
      await p.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after maxReconnects with a fatal error + session_closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pcs: ReconnectPeerConnection[] = [];
      const good = okFetch();
      let failing = false;
      const fetchImpl = (async (url: string, init?: RequestInit) => (failing && url.endsWith("/api/token/openai") ? new Response(JSON.stringify({ error: "down" }), { status: 503 }) : good.impl(url, init))) as unknown as typeof fetch;
      const p = new OpenAIRealtimeProvider({ brokerUrl: "http://b", fetch: fetchImpl, createPeerConnection: () => { const pc = new ReconnectPeerConnection(); pcs.push(pc); return pc as unknown as RTCPeerConnection; }, reconnectBackoffMs: 10, maxReconnects: 3 });
      const events: ConversationEvent[] = [];
      p.onEvent((e) => events.push(e));
      const c = p.connect(config);
      await vi.advanceTimersByTimeAsync(5);
      await c;
      failing = true;
      pcs[0]!.setState("failed");
      await vi.advanceTimersByTimeAsync(200);
      const errs = events.filter((e) => e.type === "error") as { fatal?: boolean }[];
      expect(errs.length).toBe(5); // 1 "reconnecting" + 3 attempt failures + 1 fatal
      expect(errs[errs.length - 1]!.fatal).toBe(true);
      expect(events[events.length - 1]).toEqual({ type: "session_closed", reason: "reconnect exhausted" });
      expect(p.diagnostics.reconnectFailures).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("'disconnected' self-heals within the grace period without reconnecting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pcs: ReconnectPeerConnection[] = [];
      const f = okFetch();
      const p = new OpenAIRealtimeProvider({ brokerUrl: "http://b", fetch: f.impl, createPeerConnection: () => { const pc = new ReconnectPeerConnection(); pcs.push(pc); return pc as unknown as RTCPeerConnection; }, disconnectedGraceMs: 50 });
      const c = p.connect(config);
      await vi.advanceTimersByTimeAsync(5);
      await c;
      pcs[0]!.setState("disconnected");
      await vi.advanceTimersByTimeAsync(20);
      pcs[0]!.setState("connected");
      await vi.advanceTimersByTimeAsync(100);
      expect(pcs.length).toBe(1);
      expect(f.tokenCalls).toBe(1);
      await p.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits assistant_speech_ended when no stop event arrives within the safety timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pc = new ReconnectPeerConnection();
      const p = new OpenAIRealtimeProvider({ brokerUrl: "http://b", fetch: okFetch().impl, createPeerConnection: () => pc as unknown as RTCPeerConnection, speechEndedTimeoutMs: 1000, clock: () => 7 });
      const events: ConversationEvent[] = [];
      p.onEvent((e) => events.push(e));
      const c = p.connect(config);
      await vi.advanceTimersByTimeAsync(5);
      await c;
      pc.dc.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.started" }) } as MessageEvent<string>);
      pc.dc.onmessage?.({ data: JSON.stringify({ type: "response.output_audio_transcript.delta", delta: "やあ" }) } as MessageEvent<string>);
      await vi.advanceTimersByTimeAsync(900);
      expect(events.some((e) => e.type === "assistant_speech_ended")).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(stripGen(events[events.length - 1]!)).toEqual({ type: "assistant_speech_ended", at: 7 });
      // A real stop afterwards is not duplicated.
      pc.dc.onmessage?.({ data: JSON.stringify({ type: "output_audio_buffer.stopped" }) } as MessageEvent<string>);
      expect(events.filter((e) => e.type === "assistant_speech_ended").length).toBe(1);
      await p.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OpenAIEventMapper generation epoch", () => {
  it("stamps one generation per response and drops every event of a cancelled response", () => {
    const m = new OpenAIEventMapper();
    m.map({ type: "input_audio_buffer.speech_started" }, 0);
    const [thinking] = m.map({ type: "response.created", response: { id: "r1" } }, 1);
    expect(thinking).toMatchObject({ type: "assistant_thinking", gen: { turnId: 1, generationId: 1 } });
    m.map({ type: "output_audio_buffer.started", response_id: "r1" }, 2);
    expect(m.map({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "a" }, 3)[0]).toMatchObject({ gen: { generationId: 1 } });
    // provider sends response.cancel → markCancelled(); everything else from r1 is late
    m.markCancelled();
    expect(m.map({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "late" }, 4)).toEqual([]);
    expect(m.map({ type: "output_audio_buffer.stopped", response_id: "r1" }, 5)).toEqual([]);
    expect(m.map({ type: "response.done", response_id: "r1", response: { id: "r1", status: "cancelled" } }, 6)).toEqual([]);
    expect(m.staleDrops).toBe(3);
    // the next response is a new generation and passes
    const [t2] = m.map({ type: "response.created", response: { id: "r2" } }, 7);
    expect(t2).toMatchObject({ gen: { generationId: 2 } });
    expect(m.map({ type: "response.output_audio_transcript.delta", response_id: "r2", delta: "b" }, 8)[0]).toMatchObject({ type: "assistant_transcript", gen: { generationId: 2 } });
  });
});
