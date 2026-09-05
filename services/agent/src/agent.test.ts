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
import { IncrementalOfflineSTT } from "./adapters/stt-streaming.js";
import type { ServerMessage } from "./protocol.js";
import type { ChatMessage, LLMAdapter } from "./adapters/llm.js";
import { AivisSpeechTTS, type TTSAdapter } from "./adapters/tts.js";
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

  it("hedges a remote model's slow starts by default, never a local llama.cpp", () => {
    expect(loadConfig({ LOCAL_LLM_URL: "https://generativelanguage.googleapis.com/v1beta/openai" } as NodeJS.ProcessEnv).llmHedgeMs).toBe(1800);
    expect(loadConfig({ LOCAL_LLM_URL: "http://127.0.0.1:8080/v1" } as NodeJS.ProcessEnv).llmHedgeMs).toBe(0);
    expect(loadConfig({ LOCAL_LLM_URL: "https://generativelanguage.googleapis.com/v1beta/openai", LOCAL_LLM_HEDGE_MS: "0" } as NodeJS.ProcessEnv).llmHedgeMs).toBe(0);
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
  it("warms llama.cpp's prompt cache with a one-token request, and never asks a remote endpoint to", async () => {
    const asked: { url: string; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      asked.push({ url, body: JSON.parse(init!.body as string) });
      return new Response(JSON.stringify({ choices: [{ message: { content: "." } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const messages = [{ role: "system" as const, content: "あなたはYuiです。" }];
    await new OpenAICompatibleLLM("http://127.0.0.1:8080/v1", "m", f).warm(messages);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.body).toMatchObject({ messages, max_tokens: 1, cache_prompt: true, stream: false });
    await new OpenAICompatibleLLM("https://generativelanguage.googleapis.com/v1beta/openai", "gemini", f, "k").warm(messages);
    expect(asked).toHaveLength(1); // the cloud has no prefix cache and a billed request is not a warm-up
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
      expect(form.get("no_context")).toBe("true"); // no bleed from the previous utterance's decode
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
  constructor(private readonly text = "うん、こんにちは！今日は何してた？", private readonly delayMs = 2, private readonly firstTokenDelayMs = 0) {}
  async *stream(_m: unknown, opts: { signal?: AbortSignal }) {
    if (this.firstTokenDelayMs) await new Promise((r) => setTimeout(r, this.firstTokenDelayMs));
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
  languageCalls: (string | undefined)[] = [];
  async synthesize(text: string, signal?: AbortSignal, voice?: string, language?: string) {
    this.calls.push(text);
    this.voiceCalls.push(voice);
    this.languageCalls.push(language);
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
  it("tells the voice which language it is speaking, so an English lesson is pronounced as English", async () => {
    const { s, sent, tts } = makeSession(new FakeLLM("Morning! Did you sleep well?"));
    s.start({ systemPrompt: "x", mode: "english_lesson", language: "en-US", privacyMode: "strict_local", providerOptions: { turnPolicy: { backchannel: true } } });
    void s.onText("Hi");
    await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 5000);
    expect(new Set(tts.languageCalls)).toEqual(new Set(["en-US"]));
    // The pre-rendered fillers are in the lesson's language too — 「えーっと」 has no place in it.
    expect(tts.calls.some((t) => /^(Um|Hmm|Well),$/.test(t))).toBe(true);
    expect(tts.calls.some((t) => /えーっと|うーん|そうですね/.test(t))).toBe(false);
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
  describe("transcribe-only mode (autoRespond: false)", () => {
    it("speech is transcribed but never answered on its own; a text turn still is", async () => {
      const { s, sent, audio, vad } = makeSession();
      s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", providerOptions: { autoRespond: false } });
      vad.queue.push({ type: "speech_start", at: 0 });
      s.onAudio(new Uint8Array(640));
      vad.queue.push({ type: "speech_end", at: 500, samples: new Float32Array(8000) });
      s.onAudio(new Uint8Array(640));
      await waitFor(() => sent.some((m) => m.type === "user_transcript"), 5000);
      await new Promise((r) => setTimeout(r, 150));
      expect(sent.map((m) => m.type)).not.toContain("assistant_thinking");
      expect(audio.length).toBe(0);
      expect(s.state).toBe("idle");
      void s.onText("こんにちは");
      await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 5000);
      expect(audio.length).toBeGreaterThan(0);
    });
  });
  describe("deferred second pass (LOCAL_STT_FINAL=whisper-async)", () => {
    class BetterSTT implements STTAdapter {
      engine = "better"; ready = true; model = "better";
      async transcribe() { await new Promise((r) => setTimeout(r, 30)); return "こんにちは、ゆいさん"; }
    }
    function streaming(finalAsync: boolean, autoRespond: boolean) {
      const sent: ServerMessage[] = [];
      const vad = new ScriptedVAD();
      const audioAt: number[] = [];
      const s = new ConversationSession({
        stt: new FakeSTT(), vad, llm: new FakeLLM(), tts: new FakeTTS(), send: (m) => sent.push(m), sendAudio: () => audioAt.push(Date.now()), leadMs: 100000, chunkMs: 100,
        streamingStt: () => new IncrementalOfflineSTT(new FakeSTT(), { intervalMs: 300, minAudioMs: 400 }),
        finalStt: new BetterSTT(), finalAsync, finalAsyncGraceMs: 200,
      });
      s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", providerOptions: { autoRespond } });
      vad.queue.push({ type: "speech_start", at: 0 });
      s.onAudio(new Uint8Array(640));
      for (let i = 0; i < 40; i++) s.onAudio(new Uint8Array(640)); // 800 ms of "speech"
      vad.queue.push({ type: "speech_end", at: 820, samples: new Float32Array(8000) });
      s.onAudio(new Uint8Array(640));
      return { s, sent, audioAt };
    }
    it("client-decides path: the streaming text goes out at once, the better reading follows as a revision of the same utterance", async () => {
      const { sent } = streaming(true, false);
      await waitFor(() => sent.some((m) => m.type === "user_transcript_revised"), 8000);
      const first = sent.find((m) => m.type === "user_transcript") as { text: string; id?: number };
      const rev = sent.find((m) => m.type === "user_transcript_revised") as { text: string; id: number };
      expect(first.text).toBe("こんにちは");
      expect(first.id).toBeDefined();
      expect(rev).toEqual({ type: "user_transcript_revised", id: first.id, text: "こんにちは、ゆいさん" });
      expect(sent.indexOf(first as ServerMessage)).toBeLessThan(sent.indexOf(rev as ServerMessage));
      expect(sent.map((m) => m.type)).not.toContain("assistant_thinking"); // a revision is never a turn
    });
    it("stays off the reply's path: when the page takes the turn, the revision follows the first audio", async () => {
      const { s, sent, audioAt } = streaming(true, false);
      await waitFor(() => sent.some((m) => m.type === "user_transcript"), 8000);
      const revisedAt: number[] = [];
      const send = s["deps"].send;
      s["deps"].send = (m: ServerMessage) => { if (m.type === "user_transcript_revised") revisedAt.push(Date.now()); send(m); };
      void s.onText("こんにちは"); // the page's turn on that utterance, straight after the transcript
      await waitFor(() => sent.some((m) => m.type === "user_transcript_revised"), 8000);
      expect(audioAt.length).toBeGreaterThan(0);
      expect(revisedAt[0]!).toBeGreaterThanOrEqual(audioAt[0]!); // the pass ran after the first sound, not beside the model
    });
    it("answering here: the turn waits for the better reading, as before — no revision", async () => {
      const { sent } = streaming(true, true);
      await waitFor(() => sent.some((m) => m.type === "assistant_speech_ended"), 8000);
      expect((sent.find((m) => m.type === "user_transcript") as { text: string }).text).toBe("こんにちは、ゆいさん");
      expect(sent.map((m) => m.type)).not.toContain("user_transcript_revised");
    });
  });
  describe("barge-in confirmation (bargeInConfirmMs)", () => {
    const LONG = new FakeLLM("一つ目の理由は春が暖かいこと。二つ目は花が咲くこと。三つ目は新しい出会いがあること。四つ目もあるよ。", 15);
    it("a cough while the character speaks does not cut it off", async () => {
      const { s, sent, audio, vad } = makeSession(LONG);
      s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default", providerOptions: { bargeInConfirmMs: 500 } });
      void s.onText("理由を教えて");
      await waitFor(() => audio.length > 0, 5000);
      const before = audio.length;
      vad.queue.push({ type: "speech_start", at: 1 });
      s.onAudio(new Uint8Array(640));
      // Not yet an interruption: the character is still speaking and the client was not told.
      expect(s.state).toBe("speaking");
      expect(sent.map((m) => m.type)).not.toContain("user_speech_started");
      vad.queue.push({ type: "speech_end", at: 200, samples: new Float32Array(3200) }); // 200 ms
      s.onAudio(new Uint8Array(640));
      expect(sent.map((m) => m.type)).not.toContain("interrupted");
      expect(s.state).toBe("speaking");
      await waitFor(() => audio.length > before, 5000); // audio keeps flowing
    });
    it("speech that lasts the window is a barge-in after all", async () => {
      const { s, sent, audio, vad } = makeSession(LONG);
      s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default", providerOptions: { bargeInConfirmMs: 100 } });
      void s.onText("理由を教えて");
      await waitFor(() => audio.length > 0, 5000);
      vad.queue.push({ type: "speech_start", at: 1 });
      s.onAudio(new Uint8Array(640));
      expect(s.state).toBe("speaking");
      await waitFor(() => sent.some((m) => m.type === "interrupted"), 2000);
      // Order matters for the client: the cut, then the listening state.
      const types = sent.map((m) => m.type);
      expect(types.indexOf("interrupted")).toBeLessThan(types.lastIndexOf("user_speech_started"));
      expect(s.state).toBe("listening");
      const before = audio.length;
      await new Promise((r) => setTimeout(r, 200));
      expect(audio.length).toBe(before);
    });
    it("without the option the onset itself interrupts (operator behaviour unchanged)", async () => {
      const { s, sent, audio, vad } = makeSession(LONG);
      s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" });
      void s.onText("理由を教えて");
      await waitFor(() => audio.length > 0, 5000);
      vad.queue.push({ type: "speech_start", at: 1 });
      s.onAudio(new Uint8Array(640));
      expect(sent.map((m) => m.type)).toContain("interrupted");
      expect(s.state).toBe("listening");
    });
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
  it("takes a long first clause over a longer wait (sim 33: 「昨日、」 too short, the next comma at 27 refused, 43 chars synthesised before the first sound)", () => {
    const c = new SentenceChunker();
    const out: string[] = [];
    for (const d of ["昨日、", "3ページ目の数字について", "懸念されていた点については、", "後で修正するとのことなので、", "確認しておきたいですね。"]) out.push(...c.push(d));
    expect(out[0]).toBe("昨日、3ページ目の数字について懸念されていた点については、");
    expect(out[1]).toBe("後で修正するとのことなので、確認しておきたいですね。");
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

describe("AivisSpeech", () => {
  const speakers = [
    { name: "Anneli", styles: [{ name: "ノーマル", id: 888753760 }, { name: "怒り", id: 888753762 }] },
    { name: "つくよみちゃん", styles: [{ name: "れいせい", id: 606865152 }] },
  ];

  function engine(handler: (url: string, init?: RequestInit) => Response) {
    return new AivisSpeechTTS("http://127.0.0.1:10101", "", (async (u: string, i?: RequestInit) => handler(String(u), i)) as unknown as typeof fetch);
  }

  it("lists every style as a voice a caller can ask for", async () => {
    const a = engine((url) => (url.endsWith("/speakers") ? new Response(JSON.stringify(speakers)) : new Response("", { status: 404 })));
    await a.init();
    expect(a.ready).toBe(true);
    expect(a.voices).toEqual(["Anneli — ノーマル", "Anneli — 怒り", "つくよみちゃん — れいせい"]);
    expect(a.voice).toBe("Anneli — ノーマル"); // an unset voice takes the first real one
  });

  it("asks for the style the user chose, and never edits the query", async () => {
    const seen: string[] = [];
    let sentBody = "";
    const a = engine((url, init) => {
      seen.push(url);
      if (url.endsWith("/speakers")) return new Response(JSON.stringify(speakers));
      if (url.includes("/audio_query")) return new Response('{"accent_phrases":[],"speedScale":1}');
      sentBody = String(init?.body);
      return new Response(wavBytes(), { status: 200 });
    });
    await a.init();
    const r = await a.synthesize("こんにちは", undefined, "つくよみちゃん — れいせい");
    expect(seen.some((u) => u.includes("/audio_query") && u.includes("speaker=606865152"))).toBe(true);
    expect(seen.some((u) => u.includes("/synthesis?speaker=606865152"))).toBe(true);
    // The engine's own docs say editing the query is where VOICEVOX compatibility ends.
    expect(sentBody).toBe('{"accent_phrases":[],"speedScale":1}');
    expect(r.pcm16.length).toBeGreaterThan(0);
  });

  it("is simply not ready when the engine is not running", async () => {
    const a = engine(() => { throw new Error("ECONNREFUSED"); });
    await a.init();
    expect(a.ready).toBe(false);
  });
});

/** Minimal 16-bit mono WAV so the adapter has something to parse. */
function wavBytes(sampleRate = 24000, samples = 240): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const ascii = (off: string, s: string) => [...s].forEach((c, i) => v.setUint8(Number(off) + i, c.charCodeAt(0)));
  ascii("0", "RIFF"); v.setUint32(4, 36 + samples * 2, true); ascii("8", "WAVE");
  ascii("12", "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii("36", "data"); v.setUint32(40, samples * 2, true);
  return buf;
}

describe("covering a long think", () => {
  /** A filler is the only audio allowed out before the model has said anything, so the rules are strict. */
  function session(backchannel: boolean, llmDelayMs: number, fillers = ["えーっと、"], fillerRepeatMs?: number) {
    const sent: ServerMessage[] = [];
    const audio: Uint8Array[] = [];
    const tts = new FakeTTS();
    const s = new ConversationSession({
      stt: new FakeSTT(), vad: new ScriptedVAD(), llm: new FakeLLM("わかりました。", 5, llmDelayMs), tts,
      send: (m) => sent.push(m), sendAudio: (f) => audio.push(f), leadMs: 100000, chunkMs: 100,
      fillers, fillerAfterMs: 50, fillerRepeatMs,
    });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", providerOptions: { turnPolicy: { backchannel } } });
    return { s, sent, audio, tts };
  }

  it("says something while the model is still thinking", async () => {
    const { s, audio, tts } = session(true, 600);
    await waitFor(() => tts.calls.includes("えーっと、"), 2000); // rendered up front
    const before = audio.length;
    const t0 = Date.now();
    void s.onText("どう思う？");
    await waitFor(() => audio.length > before, 2000);
    // The model's first token is 600 ms away; the character is already making a sound.
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it("stays quiet when the persona does not use backchannels", async () => {
    const { s, audio, tts } = session(false, 600);
    await new Promise((r) => setTimeout(r, 100));
    expect(tts.calls).not.toContain("えーっと、"); // not even rendered
    const before = audio.length;
    void s.onText("どう思う？");
    await new Promise((r) => setTimeout(r, 200));
    expect(audio.length).toBe(before);
  });

  it("says a second, different thing when the think is still going, and never a third (run 47: 4 s of nothing after 「えーっと、」)", async () => {
    const { s, audio, tts } = session(true, 700, ["えーっと、", "そうですね、"], 150);
    await waitFor(() => tts.calls.includes("そうですね、"), 2000);
    const before = audio.length;
    void s.onText("どう思う？");
    await waitFor(() => audio.length >= before + 1, 2000); // 「えーっと、」 at ~50 ms
    await waitFor(() => audio.length >= before + 2, 2000); // 「そうですね、」 at ~200 ms, the model still silent
    await new Promise((r) => setTimeout(r, 200));
    // Still no answer at ~400 ms, and nothing more was said: two fillers is the cap.
    expect(audio.length).toBe(before + 2);
    await waitFor(() => tts.calls.includes("わかりました。"), 2000);
    await new Promise((r) => setTimeout(r, 300));
    expect(fillerClips(audio.slice(before))).toBe(2);
  });

  it("owns a failed think out loud instead of leaving the filler hanging (soak: 429 → filler, then nothing)", async () => {
    const failing: LLMAdapter = {
      engine: "fake", model: "fake", ready: true,
      // eslint-disable-next-line require-yield
      async *stream() { await new Promise((r) => setTimeout(r, 120)); throw new Error("llm 429: RESOURCE_EXHAUSTED"); },
      async complete() { return "{}"; },
    };
    const sent: ServerMessage[] = [];
    const tts = new FakeTTS();
    const s = new ConversationSession({
      stt: new FakeSTT(), vad: new ScriptedVAD(), llm: failing, tts,
      send: (m) => sent.push(m), sendAudio: () => {}, leadMs: 100000, chunkMs: 100,
      fillers: ["えーっと、"], fillerAfterMs: 50,
    });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", providerOptions: { turnPolicy: { backchannel: true } } });
    await waitFor(() => tts.calls.includes("えーっと、"), 2000);
    await s.onText("どう思う？");
    expect(tts.calls).toContain("ごめん、いま考えがまとまらなかった。もう一回言ってもらえる？");
    expect(sent.some((m) => m.type === "error" && /429/.test((m as { message: string }).message))).toBe(true);
    const transcript = sent.find((m) => m.type === "assistant_transcript" && (m as { final?: boolean }).final) as { text: string } | undefined;
    expect(transcript?.text).toBe("ごめん、いま考えがまとまらなかった。もう一回言ってもらえる？");
  });

  it("climbs a ladder of recovery lines while the model stays down, and starts over once it answers (soak 20: 13 identical apologies)", async () => {
    let down = true;
    const flaky: LLMAdapter = {
      engine: "fake", model: "fake", ready: true,
      async *stream() { await new Promise((r) => setTimeout(r, 20)); if (down) throw new Error("llm 429: RESOURCE_EXHAUSTED"); yield "はい。"; },
      async complete() { return "{}"; },
    };
    const tts = new FakeTTS();
    const s = new ConversationSession({
      stt: new FakeSTT(), vad: new ScriptedVAD(), llm: flaky, tts,
      send: () => {}, sendAudio: () => {}, leadMs: 100000, chunkMs: 100, fillers: [],
    });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local", providerOptions: { turnPolicy: { backchannel: true } } });
    for (let i = 0; i < 4; i++) await s.onText(`質問${i}`);
    const said = () => tts.calls.filter((c) => !/^質問/.test(c));
    expect(said()).toEqual([
      "ごめん、いま考えがまとまらなかった。もう一回言ってもらえる？",
      "うーん、まだうまく言葉が出てこないや。ちょっとだけ待ってね。",
      "ごめんね、いまちょっと調子が悪いみたい。落ち着いたらまた話すね。",
      "ごめんね、いまちょっと調子が悪いみたい。落ち着いたらまた話すね。", // the last one repeats, never a fourth phrasing
    ]);
    down = false;
    await s.onText("質問4");
    down = true;
    await s.onText("質問5");
    // An answer in between puts the ladder back at the first rung.
    expect(said().slice(-2)).toEqual(["はい。", "ごめん、いま考えがまとまらなかった。もう一回言ってもらえる？"]);
  }, 15_000); // six spoken turns at FakeTTS's one second each

  it("does not repeat the filler once the model has started", async () => {
    const { s, audio, tts } = session(true, 120, ["えーっと、", "そうですね、"], 150);
    await waitFor(() => tts.calls.includes("そうですね、"), 2000);
    const before = audio.length;
    void s.onText("どう思う？");
    await waitFor(() => tts.calls.includes("わかりました。"), 2000);
    await new Promise((r) => setTimeout(r, 300));
    // One filler at 50 ms; the first token came at 120 ms, so the 200 ms repeat found nothing to cover.
    // Everything after the first clip is the answer itself, in 100 ms chunks.
    expect(fillerClips(audio.slice(before))).toBe(1);
    expect(audio.length).toBeGreaterThan(before + 1);
    expect(tts.calls.filter((c) => c === "わかりました。").length).toBe(1);
  });

  /** A pre-rendered filler goes out as one whole clip (1 s from FakeTTS); the answer is re-framed to 100 ms. */
  const fillerClips = (frames: Uint8Array[]) => frames.filter((f) => f.byteLength > 16000).length;

  it("does not cover a think that was not long", async () => {
    const { s, audio, tts } = session(true, 0);
    await waitFor(() => tts.calls.includes("えーっと、"), 2000);
    const before = audio.length;
    void s.onText("どう思う？");
    await waitFor(() => audio.length > before, 3000);
    await new Promise((r) => setTimeout(r, 150));
    // The model answered immediately, so the only thing spoken is the answer.
    expect(tts.calls.filter((c) => c === "わかりました。").length).toBeGreaterThan(0);
  });
});

describe("the first turn costs what the rest do", () => {
  it("reads the system prompt into the model at session start, before anyone has spoken", async () => {
    const warmed: ChatMessage[][] = [];
    class WarmingLLM extends FakeLLM {
      async warm(m: ChatMessage[]) { warmed.push(m); }
    }
    const { s } = makeSession(new WarmingLLM());
    s.start({ systemPrompt: "あなたはYuiです。", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    await waitFor(() => warmed.length === 1, 1000);
    expect(warmed[0]![0]).toEqual({ role: "system", content: "あなたはYuiです。" });
    // The same prompt again is already in; a new one is read again.
    s.updateContext({ systemPrompt: "あなたはYuiです。", mode: "free_talk", language: "ja-JP" });
    s.updateContext({ systemPrompt: "あなたは会議のYuiです。", mode: "free_talk", language: "ja-JP" });
    await waitFor(() => warmed.length === 2, 1000);
    expect(warmed[1]![0]!.content).toBe("あなたは会議のYuiです。");
  });
});

describe("what the character remembers saying", () => {
  it("has its own last turn in context before the next one starts", async () => {
    const seen: ChatMessage[][] = [];
    class RecordingLLM extends FakeLLM {
      override async *stream(m: ChatMessage[], opts: { signal?: AbortSignal }) {
        seen.push([...m]);
        yield* super.stream(m, opts);
      }
    }
    const { s } = makeSession(new RecordingLLM("こんにちは！"));
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    await s.onText("やあ");
    await s.onText("週末は何してた？");
    // The second call must be able to see that it already said hello — this is the difference between
    // a conversation and a series of first meetings.
    expect(seen).toHaveLength(2);
    expect(seen[1]!.some((m) => m.role === "assistant" && m.content.includes("こんにちは"))).toBe(true);
  });

  it("remembers a turn it was cut off in the middle of", async () => {
    const seen: ChatMessage[][] = [];
    class RecordingLLM extends FakeLLM {
      override async *stream(m: ChatMessage[], opts: { signal?: AbortSignal }) {
        seen.push([...m]);
        yield* super.stream(m, opts);
      }
    }
    const { s, vad } = makeSession(new RecordingLLM("春はあたたかいし、花も咲くし、出会いもあります。", 20));
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" });
    void s.onText("春が好きな理由は？");
    await new Promise((r) => setTimeout(r, 120));
    vad.queue.push({ type: "speech_start", at: 1 });
    s.onAudio(new Uint8Array(640)); // barge-in
    await new Promise((r) => setTimeout(r, 60));
    await s.onText("ごめん、もう一度");
    const last = seen[seen.length - 1]!;
    // Whatever it managed to say is in context; the room heard that much.
    expect(last.some((m) => m.role === "assistant" && m.content.length > 0)).toBe(true);
  });
});

describe("what the character remembers from earlier in the conversation", () => {
  it("keeps a running note of what scrolled out of the window and shows it to the model", async () => {
    const seen: ChatMessage[][] = [];
    class RecordingLLM extends FakeLLM {
      override async *stream(m: ChatMessage[], opts: { signal?: AbortSignal }) {
        seen.push([...m]);
        yield* super.stream(m, opts);
      }
      override async complete() { return "- 相手は週末に京都へ行った"; }
    }
    const sent: ServerMessage[] = [];
    const llm = new RecordingLLM("そうなんだ！");
    const s = new ConversationSession({ stt: new FakeSTT(), vad: new ScriptedVAD(), llm, tts: new FakeTTS(), send: (m) => sent.push(m), sendAudio: () => {}, leadMs: 100000, chunkMs: 100, historyChars: 60 });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    await s.onText("週末に京都に行ってきたんだよ。抹茶のパフェを食べた。");
    for (const line of ["犬を飼ってて、モモっていうの。", "柴犬で三歳。", "明日は面談なんだ。", "ちょっと緊張する。", "でも頑張る。", "それでさ。", "うん。", "そうそう。", "ところで週末どこ行ったか覚えてる？"]) {
      await s.onText(line);
    }
    await new Promise((r) => setTimeout(r, 20));
    const last = seen[seen.length - 1]!;
    // 京都 has long left the verbatim window …
    expect(last.some((m) => m.role === "user" && m.content.includes("京都"))).toBe(false);
    // … but the model still sees it, as the character's notes.
    expect(last[0]!.role).toBe("system");
    expect(last[0]!.content).toContain("京都");
    expect(last[1]!.role).toBe("user");
  }, 20000);
  it("reads the prompt back into the model after a fold, while the voice is still speaking", async () => {
    // Run 89: the first token after every "memory folded" took 1.9–2.4 s (0.35–0.45 s otherwise) — the
    // fold's own request had taken the slot's cache and the notes had changed the system message.
    const warmed: ChatMessage[][] = [];
    class FoldingLLM extends FakeLLM {
      async warm(m: ChatMessage[]) { warmed.push(m); }
      override async complete() { return "- 相手は週末に京都へ行った"; }
    }
    const sent: ServerMessage[] = [];
    const s = new ConversationSession({ stt: new FakeSTT(), vad: new ScriptedVAD(), llm: new FoldingLLM("そうなんだ！"), tts: new FakeTTS(), send: (m) => sent.push(m), sendAudio: () => {}, leadMs: 100000, chunkMs: 100, historyChars: 10 });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    await waitFor(() => warmed.length === 1, 1000);
    // Two exchanges fit nothing out of a 10-character window until the third turn cuts it in half.
    await s.onText("週末に京都に行ってきたんだよ。");
    await s.onText("抹茶のパフェを食べた。");
    expect(warmed.length).toBe(1); // nothing folded yet → nothing to re-read
    await s.onText("犬を飼ってて、モモっていうの。");
    await waitFor(() => warmed.length === 2, 2000);
    // What was read is the prompt the next turn will send: the persona with the fresh notes under it.
    expect(warmed[1]![0]!.role).toBe("system");
    expect(warmed[1]![0]!.content).toContain("京都");
  }, 20000);
  it("folds only once every phrase of the reply is synthesised, and before the voice has finished", async () => {
    // Run 90, pass 3: the fold's 6 s request ran alongside Supertonic and each phrase took 1.4 s
    // instead of 0.3 s. Synthesis ends seconds before playback does — the fold fits in between.
    const marks: { at: number; what: string }[] = [];
    class FoldingLLM extends FakeLLM {
      async warm() {}
      override async complete() { marks.push({ at: Date.now(), what: "fold" }); return "- 相手は週末に京都へ行った"; }
    }
    class SlowTTS extends FakeTTS {
      override async synthesize(text: string, signal?: AbortSignal, voice?: string, language?: string) {
        const r = await super.synthesize(text, signal, voice, language);
        await new Promise((res) => setTimeout(res, 60));
        marks.push({ at: Date.now(), what: `synth ${text}` });
        return r;
      }
    }
    const sent: ServerMessage[] = [];
    const s = new ConversationSession({ stt: new FakeSTT(), vad: new ScriptedVAD(), llm: new FoldingLLM("はい。そうです。"), tts: new SlowTTS(), send: (m) => { sent.push(m); if (m.type === "assistant_speech_ended") marks.push({ at: Date.now(), what: "ended" }); }, sendAudio: () => {}, leadMs: 0, chunkMs: 100, historyChars: 10 });
    s.start({ systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "strict_local" });
    await s.onText("週末に京都に行ってきたんだよ。");
    await s.onText("抹茶のパフェを食べた。");
    await s.onText("犬を飼ってて、モモっていうの。"); // the window is over budget: this turn folds
    await waitFor(() => marks.filter((m) => m.what === "fold").length >= 1, 5000);
    const synths = marks.filter((m) => m.what.startsWith("synth"));
    const fold = marks.find((m) => m.what === "fold")!;
    const ended = marks.filter((m) => m.what === "ended");
    // The fold started after the last phrase of that reply came back from the voice …
    const lastSynth = synths[synths.length - 1]!;
    expect(lastSynth.what).toBe("synth そうです。");
    expect(fold.at).toBeGreaterThanOrEqual(lastSynth.at);
    // … and while the two one-second phrases were still being paced out to the room.
    expect(ended.length).toBe(3);
    expect(fold.at).toBeLessThan(ended[2]!.at - 500);
  }, 20000);
});
