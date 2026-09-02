import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseWav } from "../wav.js";
import { AsyncQueue } from "../queue.js";

export interface TTSResult {
  sampleRate: number;
  pcm16: Int16Array;
}

export interface TTSAdapter {
  readonly engine: string;
  readonly ready: boolean;
  readonly voice: string;
  /** Voices this engine can actually use on this machine (undefined = unknown). */
  readonly voices?: string[];
  /** `voice` overrides the adapter's configured voice for this utterance (the user's choice). */
  synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<TTSResult>;
  /**
   * Optional streaming path: audio chunks are yielded as the engine produces them, so playback
   * can start before the whole phrase is synthesized. The request must be issued when this is
   * called (not when iteration starts) so a caller can queue the next phrase early.
   */
  synthesizeStream?(text: string, signal?: AbortSignal, voice?: string): AsyncIterable<TTSResult>;
}

/** macOS `say` — dev/fallback TTS; no network, ships with the OS. ~0.65–0.77 s fixed spawn/file overhead per call. */
export class SayTTS implements TTSAdapter {
  readonly engine = "macos-say";
  ready = false;
  constructor(readonly voice = "Kyoko", readonly sampleRate = 24000, readonly rate?: number) {}

  async init(): Promise<void> {
    this.ready = process.platform === "darwin";
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<TTSResult> {
    const file = path.join(os.tmpdir(), `rcai-say-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    const args = ["-v", voice || this.voice, `--data-format=LEI16@${this.sampleRate}`, "-o", file];
    if (this.rate) args.push("-r", String(this.rate));
    args.push(text);
    await new Promise<void>((resolve, reject) => {
      const child = spawn("say", args, { stdio: "ignore" });
      const onAbort = () => { child.kill("SIGKILL"); reject(new Error("aborted")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("exit", (code) => {
        signal?.removeEventListener("abort", onAbort);
        code === 0 ? resolve() : reject(new Error(`say exited ${code}`));
      });
    });
    try {
      const bytes = new Uint8Array(await fs.readFile(file));
      const wav = parseWav(bytes);
      return { sampleRate: wav.sampleRate, pcm16: wav.pcm16 };
    } finally {
      fs.unlink(file).catch(() => {});
    }
  }
}

/**
 * Supertonic 3 — on-device neural TTS, 31 languages including Japanese.
 *
 * Four ONNX models and a vocoder, run through the vendor's own Node implementation (MIT) rather than a
 * reimplementation: a four-stage pipeline reproduced from a description is a guess, and a guess here
 * produces confident noise. `scripts/fetch-supertonic.sh` puts the weights and that helper in
 * vendor/supertonic; nothing leaves the machine at synthesis time.
 *
 * Measured on this Mac, CPU: 452 ms to load, and roughly 0.58× realtime — 2.1 s of compute for 3.7 s
 * of speech. That is faster than realtime but nothing like the resident macOS daemon's 60 ms to first
 * audio, so it is a quality choice rather than a latency one.
 */
export class SupertonicTTS implements TTSAdapter {
  readonly engine = "supertonic-3";
  ready = false;
  voice: string;
  /** The open-weight release ships ten preset styles; the picker offers them by name. */
  readonly voices = ["F1", "F2", "F3", "F4", "F5", "M1", "M2", "M3", "M4", "M5"];
  private tts: { call(text: string, lang: string, style: unknown, steps: number, speed: number): Promise<{ wav: Float32Array; duration: number[] }>; sampleRate: number } | null = null;
  private styles = new Map<string, unknown>();
  private loadStyle: ((paths: string[], verbose: boolean) => unknown) | null = null;
  initError: string | null = null;

  constructor(
    private readonly dir: string,
    voice = "F1",
    private readonly opts: { language?: string; steps?: number; speed?: number } = {},
  ) {
    this.voice = this.voices.includes(voice) ? voice : "F1";
  }

  async init(): Promise<void> {
    if (!fsSync.existsSync(path.join(this.dir, "helper.js"))) return;
    try {
      const helper = (await import(/* @vite-ignore */ path.join(this.dir, "helper.js"))) as {
        loadTextToSpeech(onnxDir: string, useGpu: boolean): Promise<NonNullable<SupertonicTTS["tts"]>>;
        loadVoiceStyle(paths: string[], verbose: boolean): unknown;
      };
      this.tts = await helper.loadTextToSpeech(path.join(this.dir, "onnx"), false);
      this.loadStyle = helper.loadVoiceStyle;
      this.ready = true;
    } catch (err) {
      this.initError = err instanceof Error ? err.message : String(err);
      this.ready = false;
    }
  }

  private styleFor(voice?: string): unknown {
    const name = voice && this.voices.includes(voice) ? voice : this.voice;
    let style = this.styles.get(name);
    if (!style) {
      style = this.loadStyle!([path.join(this.dir, "voice_styles", `${name}.json`)], false);
      this.styles.set(name, style);
    }
    return style;
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<TTSResult> {
    if (!this.ready || !this.tts) throw new Error("supertonic not ready");
    const { wav, duration } = await this.tts.call(text, this.opts.language ?? "ja", this.styleFor(voice), this.opts.steps ?? 8, this.opts.speed ?? 1.05);
    if (signal?.aborted) throw new Error("aborted");
    // The model returns a fixed-size buffer; only `duration` says how much of it is speech.
    const used = Math.min(wav.length, Math.floor((duration[0] ?? 0) * this.tts.sampleRate));
    const pcm16 = new Int16Array(used);
    for (let i = 0; i < used; i++) pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(wav[i]! * 32767)));
    return { sampleRate: this.tts.sampleRate, pcm16 };
  }
}

/**
 * AivisSpeech — a local Japanese TTS built for character voices.
 *
 * macOS's voices read text; they do not act. For a character people are supposed to enjoy talking to,
 * that difference is the product. AivisSpeech runs on this machine (nothing leaves it), speaks
 * VOICEVOX's HTTP API, and ships voices that sound like someone rather than something.
 *
 * Two calls per utterance: `/audio_query` turns text into synthesis parameters, `/synthesis` renders
 * them. The query is passed through untouched — the engine's own docs warn that editing it is where
 * VOICEVOX compatibility stops being compatible.
 */
export class AivisSpeechTTS implements TTSAdapter {
  readonly engine = "aivis-speech";
  ready = false;
  voice: string;
  voices: string[] = [];
  /** Style id per "Speaker — Style" label, so a caller can ask for a voice by name. */
  private styleIds = new Map<string, number>();

  constructor(private readonly baseUrl = "http://127.0.0.1:10101", voice = "", private readonly fetchImpl: typeof fetch = fetch) {
    this.voice = voice;
  }

  async init(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/speakers`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return;
      const speakers = (await res.json()) as { name: string; styles: { name: string; id: number }[] }[];
      for (const sp of speakers) {
        for (const st of sp.styles ?? []) {
          const label = `${sp.name} — ${st.name}`;
          this.styleIds.set(label, st.id);
          this.voices.push(label);
        }
      }
      if (!this.voices.length) return;
      // An unknown configured voice is not a reason to fail: the first style is a real voice.
      if (!this.styleIds.has(this.voice)) this.voice = this.voices[0]!;
      this.ready = true;
    } catch {
      // Not installed, not running, or a different engine on the port.
      this.ready = false;
    }
  }

  private idFor(voice?: string): number {
    const key = voice && this.styleIds.has(voice) ? voice : this.voice;
    return this.styleIds.get(key) ?? 0;
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<TTSResult> {
    const base = this.baseUrl.replace(/\/$/, "");
    const speaker = this.idFor(voice);
    const q = await this.fetchImpl(`${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: "POST", signal });
    if (!q.ok) throw new Error(`aivis audio_query ${q.status}`);
    const query = await q.text(); // passed through untouched: editing it is where compatibility ends
    const res = await this.fetchImpl(`${base}/synthesis?speaker=${speaker}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/wav" },
      body: query,
      signal,
    });
    if (!res.ok) throw new Error(`aivis synthesis ${res.status}`);
    const wav = parseWav(new Uint8Array(await res.arrayBuffer()));
    return { sampleRate: wav.sampleRate, pcm16: wav.pcm16 };
  }
}

// ---- resident AVSpeechSynthesizer daemon (tools/tts-daemon) -----------------------------------

/** One record of the daemon's stdout framing: [uint32 LE id][uint8 kind][uint32 LE len][payload]. */
export interface DaemonRecord {
  id: number;
  kind: 0 | 1 | 2 | 3; // header | audio | done | error
  payload: Uint8Array;
}

/** Incremental parser for the daemon framing (exported for tests). */
export class DaemonRecordParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): DaemonRecord[] {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    const out: DaemonRecord[] = [];
    let off = 0;
    while (merged.length - off >= 9) {
      const view = new DataView(merged.buffer, merged.byteOffset + off, 9);
      const id = view.getUint32(0, true);
      const kind = view.getUint8(4) as DaemonRecord["kind"];
      const len = view.getUint32(5, true);
      if (merged.length - off < 9 + len) break;
      out.push({ id, kind, payload: merged.slice(off + 9, off + 9 + len) });
      off += 9 + len;
    }
    this.buf = merged.slice(off);
    return out;
  }
}

/**
 * The UI offers voices by name ("Kyoko"); AVSpeech wants an identifier. An unknown identifier makes the
 * daemon fall back to the default ja-JP voice, so a wrong guess degrades rather than fails.
 */
export function avSpeechVoiceId(voice?: string): string | undefined {
  if (!voice) return undefined;
  return voice.includes(".") ? voice : `com.apple.voice.compact.ja-JP.${voice}`;
}

export interface AVSpeechDaemonOptions {
  binaryPath: string;
  voice?: string; // AVSpeechSynthesisVoice identifier
  rate?: number; // 0..1, AVSpeechUtteranceDefaultSpeechRate = 0.5
  pitch?: number;
}

/**
 * Streaming TTS through a resident `AVSpeechSynthesizer` process (tools/tts-daemon).
 * No per-utterance process spawn, no temp files; PCM16 chunks arrive as the synthesizer writes them.
 * Measured on this Mac: first audio ≈ 60 ms after the request (vs ≈ 700 ms for `say`).
 */
export class AVSpeechDaemonTTS implements TTSAdapter {
  readonly engine = "avspeech-daemon";
  ready = false;
  readonly voice: string;
  /** Filled from the daemon's pong: the ja voices installed on this Mac, so the UI never offers a missing one. */
  voices: string[] = [];
  private child: ChildProcessWithoutNullStreams | null = null;
  private parser = new DaemonRecordParser();
  private queues = new Map<number, { q: AsyncQueue<TTSResult>; sampleRate: number; done: boolean }>();
  private nextId = 1;
  private restarts = 0;

  constructor(private readonly opts: AVSpeechDaemonOptions) {
    this.voice = opts.voice ?? "com.apple.voice.compact.ja-JP.Kyoko";
  }

  async init(): Promise<void> {
    if (process.platform !== "darwin" || !fsSync.existsSync(this.opts.binaryPath)) {
      this.ready = false;
      return;
    }
    await this.spawnDaemon();
    // ping → pong proves the process is alive and lists Japanese voices
    const pong = await this.ping(3000);
    this.ready = pong;
  }

  private async spawnDaemon(): Promise<void> {
    const child = spawn(this.opts.binaryPath, [this.voice], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.on("data", (d: Buffer) => {
      for (const rec of this.parser.push(new Uint8Array(d.buffer, d.byteOffset, d.byteLength))) this.onRecord(rec);
    });
    child.stderr.on("data", () => {});
    child.on("exit", () => {
      for (const e of this.queues.values()) e.q.close();
      this.queues.clear();
      this.child = null;
      this.ready = false;
      if (this.restarts++ < 3) void this.spawnDaemon().then(() => (this.ready = true));
    });
    // give the process a moment to pre-warm (the first synth loads the voice)
    await new Promise((r) => setTimeout(r, 50));
  }

  private pending = new Map<number, (ok: boolean) => void>();

  private ping(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(0); resolve(false); }, timeoutMs);
      this.pending.set(0, (ok) => { clearTimeout(timer); resolve(ok); });
      this.child?.stdin.write(JSON.stringify({ ping: true }) + "\n");
    });
  }

  private onRecord(rec: DaemonRecord): void {
    if (rec.id === 0 && rec.kind === 0) {
      try {
        const p = JSON.parse(new TextDecoder().decode(rec.payload)) as { voices?: string[] };
        if (Array.isArray(p.voices)) this.voices = p.voices;
      } catch { /* pong without a voice list */ }
      this.pending.get(0)?.(true);
      this.pending.delete(0);
      return;
    }
    const entry = this.queues.get(rec.id);
    if (!entry) return;
    if (rec.kind === 0) {
      try {
        const h = JSON.parse(new TextDecoder().decode(rec.payload)) as { sampleRate?: number };
        if (h.sampleRate) entry.sampleRate = h.sampleRate;
      } catch { /* ignore */ }
      return;
    }
    if (rec.kind === 1) {
      const aligned = rec.payload.byteLength % 2 === 0 ? rec.payload : rec.payload.subarray(0, rec.payload.byteLength - 1);
      const pcm16 = new Int16Array(aligned.buffer.slice(aligned.byteOffset, aligned.byteOffset + aligned.byteLength));
      entry.q.push({ sampleRate: entry.sampleRate, pcm16 });
      return;
    }
    // done / error (error = cancelled): close once
    if (!entry.done) {
      entry.done = true;
      entry.q.close();
      this.queues.delete(rec.id);
    }
  }

  synthesizeStream(text: string, signal?: AbortSignal, voice?: string): AsyncIterable<TTSResult> {
    const id = this.nextId++;
    const q = new AsyncQueue<TTSResult>();
    const entry = { q, sampleRate: 22050, done: false };
    this.queues.set(id, entry);
    const onAbort = () => {
      if (!entry.done) {
        this.child?.stdin.write(JSON.stringify({ id, cancel: true }) + "\n");
        entry.done = true;
        q.close();
        this.queues.delete(id);
      }
    };
    if (signal?.aborted) onAbort();
    else {
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!this.child) {
        q.close();
        this.queues.delete(id);
        throw new Error("tts daemon not running");
      }
      this.child.stdin.write(JSON.stringify({ id, text, voice: avSpeechVoiceId(voice) ?? this.voice, rate: this.opts.rate ?? 0.5, pitch: this.opts.pitch }) + "\n");
    }
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of q) yield chunk;
        } finally {
          signal?.removeEventListener("abort", onAbort);
          self.queues.delete(id);
        }
      },
    };
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<TTSResult> {
    const parts: Int16Array[] = [];
    let sampleRate = 22050;
    let total = 0;
    for await (const c of this.synthesizeStream(text, signal, voice)) {
      parts.push(c.pcm16);
      sampleRate = c.sampleRate;
      total += c.pcm16.length;
    }
    const pcm16 = new Int16Array(total);
    let off = 0;
    for (const p of parts) { pcm16.set(p, off); off += p.length; }
    return { sampleRate, pcm16 };
  }

  async close(): Promise<void> {
    this.restarts = 99;
    this.child?.kill();
    this.child = null;
  }
}

/**
 * Style-Bert-VITS2 API server (`server_fastapi.py`): GET /voice?text=&model_id=&speaker_id=&style=&language=JP → audio/wav.
 * Reference: https://github.com/litagin02/Style-Bert-VITS2 (docs/source-manifest.md lists the yonenn fork).
 */
export class StyleBertVits2TTS implements TTSAdapter {
  readonly engine = "style-bert-vits2";
  ready = false;
  constructor(private readonly baseUrl: string, readonly voice = "0", private readonly opts: { speakerId?: number; style?: string; styleWeight?: number; language?: string } = {}, private readonly fetchImpl: typeof fetch = fetch) {}

  async init(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/models/info`);
      this.ready = res.ok;
    } catch {
      this.ready = false;
    }
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<TTSResult> {
    const q = new URLSearchParams({ text, model_id: this.voice, speaker_id: String(this.opts.speakerId ?? 0), language: this.opts.language ?? "JP" });
    if (this.opts.style) q.set("style", this.opts.style);
    if (this.opts.styleWeight !== undefined) q.set("style_weight", String(this.opts.styleWeight));
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/voice?${q.toString()}`, { headers: { accept: "audio/wav" }, signal });
    if (!res.ok) throw new Error(`sbv2 ${res.status}`);
    const wav = parseWav(new Uint8Array(await res.arrayBuffer()));
    return { sampleRate: wav.sampleRate, pcm16: wav.pcm16 };
  }
}
