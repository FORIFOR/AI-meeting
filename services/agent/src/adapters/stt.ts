import fs from "node:fs";
import path from "node:path";
import { loadSherpa } from "./sherpa.js";
import { encodeWav } from "../wav.js";
import { float32ToPcm16 } from "../protocol.js";

export interface STTAdapter {
  readonly engine: string;
  readonly ready: boolean;
  readonly model: string;
  /** Transcribe a complete utterance (Float32 mono @ sampleRate). */
  transcribe(samples: Float32Array, sampleRate: number, language: string): Promise<string>;
}

/** sherpa-onnx offline recognizer: SenseVoice (preferred, punctuation + multilingual) or ReazonSpeech zipformer. */
export class SherpaSTT implements STTAdapter {
  readonly engine = "sherpa-onnx";
  ready = false;
  model = "";
  private recognizer: InstanceType<NonNullable<ReturnType<typeof loadSherpa>>["OfflineRecognizer"]> | null = null;
  private kind: "sense_voice" | "zipformer" | null = null;
  /**
   * SenseVoice takes its language in the *model* config, not per stream (the per-stream hint below is a
   * no-op on sherpa-onnx's node API). Left on "auto", a real room's coughs and keyboard noise came back as
   * Chinese — 「嗯什了你」「给个ら啊」「喂好好」 (Gate #8 run 44) — and the character answered them. One
   * recognizer per requested language, built on demand; the initial one is the default language.
   */
  private readonly byLanguage = new Map<string, InstanceType<NonNullable<ReturnType<typeof loadSherpa>>["OfflineRecognizer"]>>();
  private static readonly SENSE_VOICE_LANGUAGES = new Set(["zh", "en", "ja", "ko", "yue"]);

  constructor(private readonly modelDir: string | null, private readonly threads = 2, private readonly defaultLanguage = "ja") {}

  private senseVoiceLanguage(language: string): string {
    const code = language.split("-")[0]?.toLowerCase() ?? "";
    return SherpaSTT.SENSE_VOICE_LANGUAGES.has(code) ? code : "auto";
  }

  private buildSenseVoice(dir: string, model: string, language: string) {
    const sherpa = loadSherpa()!;
    return new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { senseVoice: { model: path.join(dir, model), language, useInverseTextNormalization: 1 }, tokens: path.join(dir, "tokens.txt"), numThreads: this.threads, provider: "cpu", debug: 0 },
    });
  }

  async init(): Promise<void> {
    const sherpa = loadSherpa();
    if (!sherpa || !this.modelDir || !fs.existsSync(this.modelDir)) return;
    const dir = this.modelDir;
    const has = (f: string) => fs.existsSync(path.join(dir, f));
    try {
      if (has("model.int8.onnx") || has("model.onnx")) {
        const model = has("model.int8.onnx") ? "model.int8.onnx" : "model.onnx";
        const language = this.senseVoiceLanguage(this.defaultLanguage);
        this.recognizer = this.buildSenseVoice(dir, model, language);
        this.byLanguage.set(language, this.recognizer);
        this.kind = "sense_voice";
      } else {
        const pick = (prefix: string) => fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".onnx") && f.includes("int8")) ?? fs.readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".onnx"));
        const enc = pick("encoder"), dec = pick("decoder"), joi = pick("joiner");
        if (!enc || !dec || !joi) throw new Error("no transducer files");
        this.recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: { transducer: { encoder: path.join(dir, enc), decoder: path.join(dir, dec), joiner: path.join(dir, joi) }, tokens: path.join(dir, "tokens.txt"), numThreads: this.threads, provider: "cpu", debug: 0 },
        });
        this.kind = "zipformer";
      }
      this.model = `${this.kind}:${path.basename(dir)}`;
      this.ready = true;
    } catch (err) {
      console.warn("[agent] sherpa STT init failed:", (err as Error).message);
    }
  }

  async transcribe(samples: Float32Array, sampleRate: number, language: string): Promise<string> {
    if (!this.recognizer) throw new Error("sherpa STT not ready");
    let recognizer = this.recognizer;
    if (this.kind === "sense_voice" && this.modelDir) {
      const code = this.senseVoiceLanguage(language);
      let forLanguage = this.byLanguage.get(code);
      if (!forLanguage) {
        const has = (f: string) => fs.existsSync(path.join(this.modelDir!, f));
        forLanguage = this.buildSenseVoice(this.modelDir, has("model.int8.onnx") ? "model.int8.onnx" : "model.onnx", code);
        this.byLanguage.set(code, forLanguage);
      }
      recognizer = forLanguage;
    }
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    recognizer.decode(stream);
    return recognizer.getResult(stream).text.trim();
  }
}

/** whisper.cpp `whisper-server` HTTP adapter (`POST /inference`, multipart file=wav). */
export class WhisperServerSTT implements STTAdapter {
  readonly engine = "whisper.cpp";
  ready = false;
  model = "whisper-server";

  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = fetch) {}

  async init(): Promise<void> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/`, { method: "GET" });
      this.ready = res.status < 500;
    } catch {
      this.ready = false;
    }
  }

  async transcribe(samples: Float32Array, sampleRate: number, language: string): Promise<string> {
    const wav = encodeWav(float32ToPcm16(samples), sampleRate);
    const form = new FormData();
    form.append("file", new Blob([wav as BlobPart], { type: "audio/wav" }), "utt.wav");
    form.append("response_format", "json");
    form.append("language", language.split("-")[0] ?? "ja");
    form.append("temperature", "0");
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/inference`, { method: "POST", body: form });
    if (!res.ok) throw new Error(`whisper-server ${res.status}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }
}
