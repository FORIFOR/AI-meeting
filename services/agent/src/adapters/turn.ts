/**
 * Smart Turn v3: has this person finished speaking, or are they thinking?
 *
 * Silence alone cannot tell the difference. 「えーっと、それは……」 followed by 400 ms of nothing is a
 * person mid-thought; the same silence after 「どう思う？」 is a question waiting for an answer. Ending
 * the turn on the first one is what makes a voice agent feel like a machine — it talks over you at
 * exactly the moment you were choosing a word.
 *
 * The model is Pipecat's, run locally through onnxruntime. Preprocessing is Whisper's own feature
 * extractor (80 mel × 800 frames = the last 8 s at 16 kHz, normalised), taken from the reference
 * implementation rather than reimplemented, because a subtly wrong mel filterbank produces confident
 * nonsense instead of an error.
 */
import fs from "node:fs";

export interface TurnDecision {
  /** 0..1: the model's probability that the turn is complete. */
  probability: number;
  complete: boolean;
}

export interface TurnAdapter {
  readonly engine: string;
  readonly ready: boolean;
  /** `samples` is mono Float32 at 16 kHz; only the last 8 seconds are used. */
  predict(samples: Float32Array): Promise<TurnDecision | null>;
}

interface OrtLike {
  InferenceSession: { create(path: string): Promise<unknown> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

const SAMPLE_RATE = 16000;
const WINDOW_SAMPLES = 8 * SAMPLE_RATE;

/** Keep the end: the decision is about how the utterance just ended, not how it began. */
export function lastWindow(samples: Float32Array, windowSamples = WINDOW_SAMPLES): Float32Array {
  const out = new Float32Array(windowSamples);
  const n = Math.min(samples.length, windowSamples);
  out.set(samples.subarray(samples.length - n), windowSamples - n);
  return out;
}

export class SmartTurnV3 implements TurnAdapter {
  readonly engine = "smart-turn-v3";
  ready = false;
  /** Why the model is not loaded, when it is not. */
  initError: string | null = null;
  private session: { run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>> } | null = null;
  private extractor: { _call(audio: Float32Array): Promise<{ input_features: { data: ArrayLike<number>; dims: number[] } }> } | null = null;
  private Tensor: (new (type: string, data: Float32Array, dims: number[]) => unknown) | null = null;

  constructor(private readonly modelPath: string | null, private readonly threshold = 0.5) {}

  async init(): Promise<void> {
    if (!this.modelPath || !fs.existsSync(this.modelPath)) return;
    try {
      // onnxruntime-node is CommonJS: depending on the loader the classes are on the namespace or on
      // `default`, and reading the wrong one fails as "cannot read InferenceSession of undefined".
      const mod = (await import("onnxruntime-node")) as unknown as { default?: OrtLike } & OrtLike;
      const ort: OrtLike = mod.InferenceSession ? mod : (mod.default as OrtLike);
      const { WhisperFeatureExtractor } = await import("@huggingface/transformers");
      this.session = (await ort.InferenceSession.create(this.modelPath)) as unknown as typeof this.session;
      this.Tensor = ort.Tensor as unknown as typeof this.Tensor;
      this.extractor = new WhisperFeatureExtractor({
        feature_size: 80,
        sampling_rate: SAMPLE_RATE,
        hop_length: 160,
        chunk_length: 8,
        n_fft: 400,
        padding_value: 0,
        n_samples: WINDOW_SAMPLES,
        nb_max_frames: 800,
        return_attention_mask: false,
      } as never) as unknown as typeof this.extractor;
      this.ready = true;
    } catch (err) {
      // A missing model or a runtime that will not load leaves `ready` false; the caller falls back to
      // silence-only endpointing rather than pretending to have an opinion.
      this.initError = err instanceof Error ? err.message : String(err);
      this.ready = false;
    }
  }

  async predict(samples: Float32Array): Promise<TurnDecision | null> {
    if (!this.ready || !this.session || !this.extractor || !this.Tensor) return null;
    try {
      const f = await this.extractor._call(lastWindow(samples));
      const tensor = new this.Tensor("float32", Float32Array.from(f.input_features.data), f.input_features.dims);
      const out = await this.session.run({ input_features: tensor });
      const probability = Number(out.logits?.data?.[0] ?? NaN);
      if (!Number.isFinite(probability)) return null;
      return { probability, complete: probability >= this.threshold };
    } catch {
      return null;
    }
  }
}
