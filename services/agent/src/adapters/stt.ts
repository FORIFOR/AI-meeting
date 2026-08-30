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

  constructor(private readonly modelDir: string | null, private readonly threads = 2) {}

  async init(): Promise<void> {
    const sherpa = loadSherpa();
    if (!sherpa || !this.modelDir || !fs.existsSync(this.modelDir)) return;
    const dir = this.modelDir;
    const has = (f: string) => fs.existsSync(path.join(dir, f));
    try {
      if (has("model.int8.onnx") || has("model.onnx")) {
        const model = has("model.int8.onnx") ? "model.int8.onnx" : "model.onnx";
        this.recognizer = new sherpa.OfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: { senseVoice: { model: path.join(dir, model), language: "auto", useInverseTextNormalization: 1 }, tokens: path.join(dir, "tokens.txt"), numThreads: this.threads, provider: "cpu", debug: 0 },
        });
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
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    if (this.kind === "sense_voice") {
      // language hint improves SenseVoice; stream option API may be absent in older builds
      try { (stream as unknown as { setOption?: (k: string, v: string) => void }).setOption?.("language", language.split("-")[0] ?? "auto"); } catch { /* ignore */ }
    }
    this.recognizer.decode(stream);
    return this.recognizer.getResult(stream).text.trim();
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
