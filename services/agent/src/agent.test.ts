import { describe, expect, it } from "vitest";
import { decodeAudioFrame, encodeAudioFrame, float32ToPcm16, pcm16BytesToFloat32 } from "./protocol.js";
import { SentenceChunker, stripMarkdown } from "./sentence.js";
import { encodeWav, parseWav } from "./wav.js";
import { isLoopbackUrl, loadConfig, nonLoopbackEndpoints } from "./config.js";
import { OpenAICompatibleLLM, parseSse } from "./adapters/llm.js";
import { StyleBertVits2TTS } from "./adapters/tts.js";
import { WhisperServerSTT } from "./adapters/stt.js";
import { EnergyVADAdapter, type VADAdapter, type VADAdapterEvent } from "./adapters/vad.js";
import { AsyncQueue, ConversationSession } from "./session.js";
import type { ServerMessage } from "./protocol.js";
import type { LLMAdapter } from "./adapters/llm.js";
import type { TTSAdapter } from "./adapters/tts.js";
import type { STTAdapter } from "./adapters/stt.js";

describe("protocol framing", () => {
  it("round-trips [uint32 sampleRate][uint32 generationId][uint32 sequence][pcm16]", () => {
    const pcm = new Int16Array([1, -2, 32767, -32768]);
    const frame = encodeAudioFrame(24000, pcm, { generationId: 5, sequence: 9 });
    expect(frame.byteLength).toBe(12 + 8);
    const d = decodeAudioFrame(frame);
    expect(d.sampleRate).toBe(24000);
    expect(d.generationId).toBe(5);
    expect(d.sequence).toBe(9);
    expect([...d.pcm16]).toEqual([1, -2, 32767, -32768]);
    const f32 = pcm16BytesToFloat32(new Uint8Array(pcm.buffer));
    expect(f32[2]).toBeCloseTo(0.99997, 4);
    expect([...float32ToPcm16(new Float32Array([1, -1, 0]))]).toEqual([32767, -32768, 0]);
  });
});

describe("SentenceChunker", () => {
  it("emits Japanese sentences as they complete and flushes the rest", () => {
    const c = new SentenceChunker();
    expect(c.push("うん、本当")).toEqual([]);
    expect(c.push("に気持ちいい天気だね！今日は")).toEqual(["うん、本当に気持ちいい天気だね！"]);
    expect(c.push("何してた？そ")).toEqual(["今日は何してた？"]);
    expect(c.flush()).toBe("そ");
    expect(c.flush()).toBeNull();
  });
  it("breaks very long clauses at a comma", () => {
    const c = new SentenceChunker(20);
    const out = c.push("これはとても長い文章で、まだ終わりが見えないのですが、さらに続きます");
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0]!.endsWith("、")).toBe(true);
  });
  it("strips markdown and emoji", () => {
    expect(stripMarkdown("**すごい**！ `code` 😊\n- item")).toBe("すごい！ code\nitem");
  });
});

describe("wav", () => {
  it("parses files with JUNK/FLLR chunks (macOS say) and round-trips", () => {
    const pcm = new Int16Array([10, 20, -30]);
    const clean = encodeWav(pcm, 16000);
    // inject a JUNK chunk before fmt
    const junk = new Uint8Array(8 + 4);
    junk.set([0x4a, 0x55, 0x4e, 0x4b, 4, 0, 0, 0]);
    const withJunk = new Uint8Array(clean.byteLength + junk.byteLength);
    withJunk.set(clean.subarray(0, 12));
    withJunk.set(junk, 12);
    withJunk.set(clean.subarray(12), 12 + junk.byteLength);
    const w = parseWav(withJunk);
    expect(w.sampleRate).toBe(16000);
    expect([...w.pcm16]).toEqual([10, 20, -30]);
  });
});

describe("strict_local guard", () => {
  it("only loopback URLs pass", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080/v1")).toBe(true);
    expect(isLoopbackUrl("ws://localhost:8788")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:5000")).toBe(true);
    expect(isLoopbackUrl("https://api.openai.com/v1")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.10:8080")).toBe(false);
    const cfg = loadConfig({ LOCAL_LLM_URL: "http://10.0.0.5:8080/v1", WHISPER_SERVER_URL: "http://127.0.0.1:8178", SBV2_URL: "http://127.0.0.1:5000" } as NodeJS.ProcessEnv);
    expect(nonLoopbackEndpoints(cfg)).toEqual(["http://10.0.0.5:8080/v1"]);
  });
});

describe("adapters with mocked fetch", () => {
  it("OpenAI-compatible LLM streams SSE deltas", async () => {
    const body = ["data: " + JSON.stringify({ choices: [{ delta: { content: "うん、" } }] }), "data: " + JSON.stringify({ choices: [{ delta: { content: "そうだね。" } }] }), "data: [DONE]", ""].join("\n");
    const f = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8080/v1/chat/completions");
      expect(JSON.parse(init!.body as string).stream).toBe(true);
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const llm = new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", f);
    const parts: string[] = [];
    for await (const d of llm.stream([{ role: "user", content: "hi" }])) parts.push(d);
    expect(parts.join("")).toBe("うん、そうだね。");
    expect(parseSse(body).length).toBe(2);
  });
  it("Style-Bert-VITS2 adapter hits /voice and parses wav; unreachable server → not ready", async () => {
    const wav = encodeWav(new Int16Array([1, 2, 3]), 44100);
    const f = (async (url: string) => {
      if (url.endsWith("/models/info")) return new Response("{}", { status: 200 });
      expect(url).toContain("/voice?text=");
      expect(url).toContain("model_id=0");
      return new Response(wav as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
    const tts = new StyleBertVits2TTS("http://127.0.0.1:5000", "0", { style: "Neutral" }, f);
    await tts.init();
    expect(tts.ready).toBe(true);
    const r = await tts.synthesize("テスト");
    expect(r.sampleRate).toBe(44100);
    expect(r.pcm16.length).toBe(3);
    const down = new StyleBertVits2TTS("http://127.0.0.1:5000", "0", {}, (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    await down.init();
    expect(down.ready).toBe(false);
  });
  it("whisper-server adapter posts multipart wav to /inference", async () => {
    const f = (async (url: string, init?: RequestInit) => {
      if (!url.endsWith("/inference")) return new Response("ok");
      const form = init!.body as FormData;
      expect(form.get("file")).toBeInstanceOf(Blob);
      expect(form.get("language")).toBe("ja");
      return new Response(JSON.stringify({ text: " こんにちは " }));
    }) as unknown as typeof fetch;
    const stt = new WhisperServerSTT("http://127.0.0.1:8178", f);
    await stt.init();
    expect(stt.ready).toBe(true);
    expect(await stt.transcribe(new Float32Array(1600), 16000, "ja-JP")).toBe("こんにちは");
  });
});

describe("EnergyVADAdapter", () => {
  it("captures the utterance with pre-roll", () => {
    const vad = new EnergyVADAdapter();
    const ev: VADAdapterEvent[] = [];
    let at = 0;
    const quiet = new Float32Array(320).fill(0.0003);
    const loud = new Float32Array(320);
    for (let i = 0; i < 320; i++) loud[i] = 0.5 * Math.sin(i / 5);
    for (let i = 0; i < 30; i++) { ev.push(...vad.process(quiet, at)); at += 20; }
    for (let i = 0; i < 20; i++) { ev.push(...vad.process(loud, at)); at += 20; }
    for (let i = 0; i < 40; i++) { ev.push(...vad.process(quiet, at)); at += 20; }
    expect(ev.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = ev[1] as { samples: Float32Array };
    expect(end.samples.length).toBeGreaterThan(20 * 320);
  });
});

// ---- Session with fake adapters -------------------------------------------

class ScriptedVAD implements VADAdapter {
  engine = "scripted";
  speaking = false;
  queue: VADAdapterEvent[] = [];
  process(): VADAdapterEvent[] { const q = this.queue; this.queue = []; return q; }
  reset() {}
}
class FakeSTT implements STTAdapter {
  engine = "fake"; ready = true; model = "fake";
  async transcribe() { await new Promise((r) => setTimeout(r, 5)); return "こんにちは"; }
}
class FakeLLM implements LLMAdapter {
  engine = "fake"; model = "fake"; ready = true;
  constructor(private readonly text = "うん、こんにちは！今日は何してた？", private readonly delayMs = 2) {}
  async *stream(_m: unknown, opts: { signal?: AbortSignal }) {
    for (const ch of this.text) {
      if (opts.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, this.delayMs));
      yield ch;
    }
  }
  async complete() { return "{}"; }
}
class FakeTTS implements TTSAdapter {
  engine = "fake"; ready = true; voice = "v";
  calls: string[] = [];
  voiceCalls: (string | undefined)[] = [];
  async synthesize(text: string, signal?: AbortSignal, voice?: string) {
    this.calls.push(text);
    this.voiceCalls.push(voice);
    await new Promise((r, rej) => { const t = setTimeout(r, 5); signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); }); });
    return { sampleRate: 16000, pcm16: new Int16Array(16000) }; // 1 s per sentence
  }
}

function makeSession(llm: LLMAdapter = new FakeLLM()) {
  const sent: ServerMessage[] = [];
  const audio: Uint8Array[] = [];
  const vad = new ScriptedVAD();
  const tts = new FakeTTS();
  const s = new ConversationSession({ stt: new FakeSTT(), vad, llm, tts, send: (m) => sent.push(m), sendAudio: (f) => audio.push(f), leadMs: 100000, chunkMs: 100 });
  return { s, sent, audio, vad, tts };
}

describe("ConversationSession", () => {
  it("runs VAD→STT→LLM→TTS and emits the unified event order", async () => {
    const { s, sent, audio, vad } = makeSession();
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    expect(sent[0]!.type).toBe("ready");
    vad.queue.push({ type: "speech_start", at: 0 });
    s.onAudio(new Uint8Array(640));
    vad.queue.push({ type: "speech_end", at: 500, samples: new Float32Array(8000) });
    s.onAudio(new Uint8Array(640));
    await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 5000);
    const types = sent.map((m) => m.type);
    expect(types.slice(0, 5)).toEqual(["ready", "user_speech_started", "user_speech_ended", "user_transcript", "assistant_thinking"]);
    expect(types.indexOf("assistant_speech_started")).toBeLessThan(types.indexOf("assistant_speech_ended"));
    const finalT = sent.find((m) => m.type === "assistant_transcript" && (m as { final: boolean }).final) as { text: string };
    expect(finalT.text).toBe("うん、こんにちは！今日は何してた？");
    expect(audio.length).toBe(20); // 2 sentences × 1 s / 100 ms chunks
    expect(decodeAudioFrame(audio[0]!).sampleRate).toBe(16000);
    expect(s.state).toBe("idle");
  });
  it("speaks with the voice the user chose for the session", async () => {
    const { s, sent, tts } = makeSession();
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", voice: "com.apple.eloquence.ja-JP.Flo" });
    void s.onText("こんにちは");
    await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 5000);
    expect(tts.voiceCalls.length).toBeGreaterThan(0);
    expect(new Set(tts.voiceCalls)).toEqual(new Set(["com.apple.eloquence.ja-JP.Flo"]));
  });
  it("keeps the engine's own voice when the user chose none", async () => {
    const { s, sent, tts } = makeSession();
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    void s.onText("こんにちは");
    await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 5000);
    expect(new Set(tts.voiceCalls)).toEqual(new Set([undefined]));
  });
  it("barge-in aborts LLM/TTS, stops audio and emits interrupted", async () => {
    const { s, sent, audio, vad, tts } = makeSession(new FakeLLM("一つ目の理由は春が暖かいこと。二つ目は花が咲くこと。三つ目は新しい出会いがあること。四つ目もあるよ。", 15));
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" });
    void s.onText("理由を教えて");
    // wait until first audio streams, then barge in
    await waitFor(() => audio.length > 0, 5000);
    const before = audio.length;
    vad.queue.push({ type: "speech_start", at: 1 });
    s.onAudio(new Uint8Array(640));
    expect(sent.map((m) => m.type)).toContain("interrupted");
    expect(s.state).toBe("listening");
    await new Promise((r) => setTimeout(r, 200));
    expect(audio.length).toBe(before);
    expect(sent.filter((m) => m.type === "assistant_speech_ended").length).toBe(0);
    expect(tts.calls.length).toBeLessThan(4);
  });
  it("rejects strict_local when an adapter endpoint is not loopback", () => {
    const sent: ServerMessage[] = [];
    const s = new ConversationSession({ stt: new FakeSTT(), vad: new ScriptedVAD(), llm: new FakeLLM(), tts: new FakeTTS(), send: (m) => sent.push(m), sendAudio: () => {}, nonLoopbackEndpoints: () => ["http://10.0.0.5:8080/v1"] });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    expect(sent[0]!.type).toBe("error");
    expect((sent[0] as { message: string }).message).toContain("strict_local");
  });
  it("AsyncQueue delivers in order and closes", async () => {
    const q = new AsyncQueue<number>();
    const p = q.next();
    q.push(1); q.push(2); q.close();
    expect(await p).toBe(1);
    expect(await q.next()).toBe(2);
    expect(await q.next()).toBeNull();
  });
});

async function waitFor(pred: () => boolean, timeoutMs: number) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > timeoutMs) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 5)); }
}

import { DaemonRecordParser, type TTSResult } from "./adapters/tts.js";
import { endsSentence } from "./sentence.js";
import { selectTts } from "./server.js";

describe("SentenceChunker first phrase (P0-3)", () => {
  it("releases the first clause at a comma so TTS can start early, then whole sentences", () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const d of ["そう", "ですね、", "その場合は", "まず計測から", "始めるのが良いと思います。", "次に", "改善します。"]) out.push(...c.push(d));
    expect(out[0]).toBe("そうですね、");
    expect(out[1]).toBe("その場合はまず計測から始めるのが良いと思います。");
    expect(out[2]).toBe("次に改善します。");
    expect(c.flush()).toBeNull();
  });
  it("does not split inside numbers or Latin text and ignores a too-short first clause", () => {
    const c = new SentenceChunker();
    expect(c.push("1,000円で、")).toEqual(["1,000円で、"]);
    const d = new SentenceChunker();
    expect(d.push("はい、")).toEqual([]); // 2 chars < firstPhraseMin
    expect(d.push("わかりました。")).toEqual(["はい、わかりました。"]);
    expect(endsSentence("わかりました。")).toBe(true);
    expect(endsSentence("そうですね、")).toBe(false);
  });
});

describe("tts daemon framing", () => {
  it("parses [id][kind][len][payload] records across chunk boundaries", () => {
    const rec = (id: number, kind: number, payload: Uint8Array) => {
      const out = new Uint8Array(9 + payload.length);
      const v = new DataView(out.buffer);
      v.setUint32(0, id, true); v.setUint8(4, kind); v.setUint32(5, payload.length, true);
      out.set(payload, 9);
      return out;
    };
    const header = rec(7, 0, new TextEncoder().encode(JSON.stringify({ id: 7, sampleRate: 22050 })));
    const audio = rec(7, 1, new Uint8Array([1, 0, 2, 0, 3, 0]));
    const done = rec(7, 2, new TextEncoder().encode("{}"));
    const all = new Uint8Array([...header, ...audio, ...done]);
    const p = new DaemonRecordParser();
    const got = [...p.push(all.subarray(0, 12)), ...p.push(all.subarray(12, 30)), ...p.push(all.subarray(30))];
    expect(got.map((r) => r.kind)).toEqual([0, 1, 2]);
    expect(new Int16Array(got[1]!.payload.buffer)).toEqual(new Int16Array([1, 2, 3]));
    expect(got[0]!.id).toBe(7);
  });
});

describe("TTS selection", () => {
  it("avspeech without a built daemon falls back to say; auto behaves the same", async () => {
    const base = loadConfig({});
    const a = await selectTts({ ...base, tts: "avspeech", ttsDaemonPath: null });
    expect(a.engine).toBe("macos-say");
    const b = await selectTts({ ...base, tts: "auto", ttsDaemonPath: "/nonexistent/rcai-tts-daemon" });
    expect(b.engine).toBe("macos-say");
  });
});

describe("ConversationSession metrics + streaming TTS", () => {
  it("emits a metrics breakdown and streams audio before the phrase is fully synthesized", async () => {
    let now = 1000;
    const clock = () => now;
    const sent: unknown[] = [];
    const audioAt: number[] = [];
    const streamTts = {
      engine: "fake-stream", ready: true, voice: "v",
      async synthesize(): Promise<TTSResult> { return { sampleRate: 16000, pcm16: new Int16Array(160) }; },
      synthesizeStream(): AsyncIterable<TTSResult> {
        return { async *[Symbol.asyncIterator]() { now += 30; yield { sampleRate: 16000, pcm16: new Int16Array(640) }; now += 30; yield { sampleRate: 16000, pcm16: new Int16Array(640) }; } };
      },
    };
    const session = new ConversationSession({
      stt: { engine: "fake-stt", ready: true, model: "m", async transcribe() { now += 80; return "こんにちは"; } },
      vad: { engine: "fake-vad", speaking: false, reset() {}, process(_s: Float32Array, at: number) { return vadEvents.splice(0).map((e) => ({ ...e, at })) as VADAdapterEvent[]; } },
      llm: { engine: "fake-llm", model: "m", ready: true, async *stream() { now += 150; yield "そうですね、"; await new Promise((r) => setTimeout(r, 20)); now += 100; yield "元気です。"; }, async complete() { return ""; } },
      tts: streamTts,
      send: (m) => sent.push(m),
      sendAudio: () => audioAt.push(now),
      clock,
      leadMs: 100000,
    });
    const vadEvents: { type: "speech_start" | "speech_end"; samples?: Float32Array; endLagSamples?: number }[] = [];
    session.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" });
    vadEvents.push({ type: "speech_start" });
    session.onAudio(new Uint8Array(640));
    vadEvents.push({ type: "speech_end", samples: new Float32Array(16000), endLagSamples: 6400 });
    session.onAudio(new Uint8Array(640));
    for (let i = 0; i < 50 && !sent.some((m) => (m as { type: string }).type === "metrics"); i++) await new Promise((r) => setTimeout(r, 5));
    const metrics = sent.find((m) => (m as { type: string }).type === "metrics") as { turn: Record<string, number | string> };
    expect(metrics).toBeDefined();
    expect(metrics.turn.vadEndMs).toBe(400);
    expect(metrics.turn.sttMs).toBe(80);
    expect(metrics.turn.llmTtftMs).toBe(150);
    expect(metrics.turn.firstPhraseMs).toBe(150);
    expect(metrics.turn.ttsTtfaMs).toBe(30);
    expect(metrics.turn.phrases).toBe(2);
    expect(metrics.turn.sentences).toBe(1);
    expect(metrics.turn.firstAudioSentMs).toBe(80 + 150 + 30);
    expect(metrics.turn.source).toBe("speech");
    // first audio chunk was sent after the first streamed TTS chunk, before the second one arrived
    expect(audioAt[0]).toBe(1000 + 80 + 150 + 30);
    const types = sent.map((m) => (m as { type: string }).type);
    expect(types.indexOf("assistant_speech_started")).toBeLessThan(types.indexOf("assistant_speech_ended"));
    expect(types[types.length - 1]).toBe("metrics");
  });
});

describe("non-streaming TTS lookahead abort", () => {
  it("does not leak an unhandled rejection when a queued phrase is aborted before iteration", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const sent: ServerMessage[] = [];
    let now = 0;
    const slowTts: TTSAdapter = {
      engine: "slow", ready: true, voice: "v",
      synthesize(_t, signal) {
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve({ sampleRate: 16000, pcm16: new Int16Array(3200) }), 60);
          signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
        });
      },
    };
    const session = new ConversationSession({
      stt: { engine: "s", ready: true, model: "m", async transcribe() { return "x"; } },
      vad: { engine: "v", speaking: false, reset() {}, process() { return []; } },
      llm: { engine: "l", model: "m", ready: true, async *stream() { yield "一つ目です。"; yield "二つ目です。"; yield "三つ目です。"; }, async complete() { return ""; } },
      tts: slowTts,
      send: (m) => sent.push(m),
      sendAudio: () => {},
      clock: () => now,
      leadMs: 100000,
    });
    session.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" });
    const turn = session.onText("hi");
    await new Promise((r) => setTimeout(r, 80)); // first phrase audio in flight, second queued
    session.interrupt("test");
    await turn;
    await new Promise((r) => setTimeout(r, 30));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    expect(sent.some((m) => m.type === "interrupted")).toBe(true);
  });
});
