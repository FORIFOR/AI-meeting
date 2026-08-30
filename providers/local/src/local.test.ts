import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { PrivacyViolationError } from "@rcai/provider-core";
import type { ConversationEvent } from "@rcai/conversation-core";
import { LocalProvider, toWsUrl } from "./provider.js";
import { isLoopbackUrl } from "./loopback.js";
import { createLocalEvaluationProvider } from "./evaluation.js";
import { LocalSTTProvider } from "./stt.js";

class FakeWS {
  static instances: FakeWS[] = [];
  readyState = 0;
  binaryType = "arraybuffer";
  sent: (string | ArrayBuffer)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWS.instances.push(this);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(d: string | ArrayBuffer) {
    this.sent.push(d);
    if (typeof d === "string" && JSON.parse(d).type === "start") setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "ready" }) }), 0);
  }
  close() { this.readyState = 3; this.onclose?.(); }
  serverSend(data: unknown) { this.onmessage?.({ data }); }
}

const cfg = { systemPrompt: "p", mode: "free_talk" as const, language: "ja-JP", privacyMode: "default" as const };

describe("LocalProvider", () => {
  it("connects, forwards audio as 16k pcm16 chunks and maps events 1:1", async () => {
    const p = new LocalProvider({ agentUrl: "http://127.0.0.1:8788", WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    const events: ConversationEvent[] = [];
    p.onEvent((e) => events.push(e));
    await p.connect(cfg);
    const ws = FakeWS.instances.at(-1)!;
    expect(ws.url).toBe("ws://127.0.0.1:8788/session");
    expect(JSON.parse(ws.sent[0] as string)).toMatchObject({ type: "start", config: { systemPrompt: "p" } });
    expect(events[0]).toEqual({ type: "session_ready", providerId: "local" });
    // 60 ms of 48k audio -> three 20 ms chunks at 16k (320 samples = 640 bytes)
    p.pushAudio(createFrame(new Float32Array(2880)));
    const bins = ws.sent.filter((s) => s instanceof ArrayBuffer) as ArrayBuffer[];
    expect(bins.length).toBe(3);
    expect(bins[0]!.byteLength).toBe(640);
    ws.serverSend(JSON.stringify({ type: "user_speech_started" }));
    ws.serverSend(JSON.stringify({ type: "user_transcript", text: "こんにちは", final: true }));
    ws.serverSend(JSON.stringify({ type: "assistant_transcript", text: "やあ", final: false }));
    const frame = new Uint8Array(12 + 480 * 2); // protocol v2 header: [rate][generationId][sequence]
    new DataView(frame.buffer).setUint32(0, 24000, true);
    new DataView(frame.buffer).setUint32(4, 3, true);
    new DataView(frame.buffer).setUint32(8, 7, true);
    ws.serverSend(frame.buffer);
    ws.serverSend(JSON.stringify({ type: "interrupted" }));
    ws.serverSend(JSON.stringify({ type: "error", message: "boom" }));
    const types = events.map((e) => e.type);
    expect(types).toEqual(["session_ready", "user_speech_started", "user_transcript", "assistant_transcript", "assistant_audio", "interrupted", "error"]);
    const audio = events.find((e) => e.type === "assistant_audio") as { frame: { sampleRate: number; data: Float32Array } };
    expect(audio.frame.sampleRate).toBe(48000);
    expect(Math.abs(audio.frame.data.length - 960)).toBeLessThanOrEqual(2);
    expect((events.find((e) => e.type === "assistant_audio") as { gen?: { generationId: number; sequence: number } }).gen).toMatchObject({ generationId: 3, sequence: 7 });
    await p.interrupt();
    await p.sendText("hi");
    expect(JSON.parse(ws.sent.at(-2) as string).type).toBe("interrupt");
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: "text", text: "hi" });
    await p.disconnect();
    expect(ws.readyState).toBe(3);
    expect(events.at(-1)!.type).toBe("session_closed");
    expect(p.capabilities().localOnly).toBe(true);
  });
  it("strict_local refuses a non-loopback agent", async () => {
    const p = new LocalProvider({ agentUrl: "http://10.0.0.7:8788", WebSocketImpl: FakeWS as unknown as typeof WebSocket });
    await expect(p.connect({ ...cfg, privacyMode: "strict_local" })).rejects.toBeInstanceOf(PrivacyViolationError);
    expect(isLoopbackUrl("ws://[::1]:8788")).toBe(true);
    expect(toWsUrl("https://localhost:8788/x?y=1")).toBe("wss://localhost:8788/session");
  });
});

describe("local evaluation + STT providers", () => {
  it("evaluator posts to /evaluate on the agent", async () => {
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8788/evaluate");
      expect(JSON.parse(init!.body as string).mode).toBe("interview");
      return new Response(JSON.stringify({ overall: 80, clarity: 1, specificity: 1, structure: 1, relevance: 1, fluency: 1, feedback: [], improvedAnswer: "" }));
    }) as unknown as typeof fetch;
    const ev = createLocalEvaluationProvider({ agentUrl: "ws://127.0.0.1:8788", fetchImpl: f });
    const r = await ev.evaluate({ mode: "interview", language: "ja-JP", transcript: [], timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] }, interruptions: { byUser: 0, byAssistant: 0 } });
    expect(r.overall).toBe(80);
    expect(r.evaluatedBy).toBe("local");
  });
  it("STT provider accumulates 48k audio and posts 16k pcm16 to /stt", async () => {
    let bodyLen = 0;
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toContain("/stt?language=ja-JP");
      bodyLen = (init!.body as ArrayBuffer).byteLength;
      return new Response(JSON.stringify({ text: "テスト" }));
    }) as unknown as typeof fetch;
    const stt = new LocalSTTProvider({ agentUrl: "http://localhost:8788", fetchImpl: f });
    await stt.start({ language: "ja-JP" });
    stt.pushAudio(createFrame(new Float32Array(4800))); // 100 ms
    const r = await stt.endUtterance();
    expect(r?.text).toBe("テスト");
    expect(Math.abs(bodyLen - 3200)).toBeLessThanOrEqual(4);
    expect(() => new LocalSTTProvider({ agentUrl: "http://example.com" })).toThrow();
  });
});
