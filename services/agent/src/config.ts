import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
  port: number;
  stt: "sherpa" | "whisper";
  /**
   * Second pass over the committed utterance with a stronger model: "whisper" (awaited: the turn reads
   * the better text, ~1 s later), "whisper-async" (the turn goes out on the streaming text at once and
   * the better reading follows as `user_transcript_revised`, for the context of later turns), or "off"
   * (default).
   */
  sttFinal: "whisper" | "whisper-async" | "off";
  sherpaModelDir: string | null;
  sileroVadModel: string | null;
  whisperServerUrl: string;
  llmUrl: string;
  llmModel: string;
  llmKey: string;
  llmReasoning: string;
  /** Characters of recent conversation kept verbatim in front of the model (older turns become notes). */
  llmHistoryChars: number;
  /** Ask the model a second time when its first token is later than this (HedgedLLM); 0 disables. */
  llmHedgeMs: number;
  /** Touch the local model this often while idle so its weights stay resident (ms); 0 disables. */
  llmKeepWarmMs: number;
  /** Directory to write each committed utterance's audio to as a wav (diagnostics; unset ⇒ off). */
  dumpUtterancesDir: string | null;
  tts: "say" | "sbv2" | "avspeech" | "aivis" | "supertonic" | "auto";
  /** Words the voice must read another way, e.g. a Latin name → its kana (`LOCAL_TTS_READINGS="Yui=ゆい"`). */
  ttsReadings: Record<string, string>;
  sbv2Url: string;
  sayVoice: string;
  /** AVSpeechSynthesisVoice identifier for the resident daemon (tools/tts-daemon). */
  avspeechVoice: string;
  aivisUrl: string;
  supertonicDir: string;
  /** One of the ten preset styles: F1–F5, M1–M5. */
  supertonicVoice: string;
  supertonicSteps: number;
  supertonicSpeed: number;
  supertonicPrecision: "float" | "int8";
  supertonicThreads: number;
  /** "Speaker — Style" as AivisSpeech names it; empty means the engine's first style. */
  aivisVoice: string;
  /** Acoustic turn-end model; null when it has not been fetched (scripts/fetch-smart-turn.sh). */
  smartTurnModel: string | null;
  /** "smart" uses the model when it is present; "off" is silence-only endpointing. */
  turn: "smart" | "off";
  /** Path to tools/tts-daemon/bin/rcai-tts-daemon (null when not built). */
  ttsDaemonPath: string | null;
  /** Silero VAD end-of-speech silence (ms) in baseline mode. Lower = faster turn end, more risk of splitting. */
  vadMinSilenceMs: number;
  /**
   * Round 3 STT mode: `baseline` = one-shot decode after a fixed 400 ms VAD silence (Gate 6 path, unchanged);
   * `incremental` = decode while the user speaks + adaptive/semantic endpointing; `online` = true streaming
   * recognizer (needs SHERPA_ONLINE_MODEL_DIR; falls back to incremental).
   */
  sttMode: "baseline" | "incremental" | "online";
  sherpaOnlineModelDir: string | null;
  /** Silero pause detection (ms) used by the endpoint policy in incremental/online modes. */
  pauseMinSilenceMs: number;
  /** Incremental decode interval (ms of new audio). */
  sttIncrementalIntervalMs: number;
  endpoint: { minSilenceMs: number; completeSilenceMs: number; unknownSilenceMs: number; incompleteSilenceMs: number; maxSilenceMs: number };
  egressLog: boolean;
}

const HOME = os.homedir();

function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

/** Known model locations on this machine (see docs/current-state.md); all overridable by env. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const deepnote = path.join(HOME, "Library/Application Support/DeepNote/models");
  return {
    port: Number(env.PORT ?? 8788),
    stt: (env.LOCAL_STT as AgentConfig["stt"]) ?? "sherpa",
    sttFinal: (env.LOCAL_STT_FINAL as AgentConfig["sttFinal"]) ?? "off",
    sherpaModelDir:
      env.SHERPA_MODEL_DIR ??
      firstExisting([
        path.join(deepnote, "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"),
        path.join(HOME, "Projects/sherpa-onnx-shared/models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"),
        path.join(deepnote, "sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01"),
      ]),
    sileroVadModel:
      env.SILERO_VAD_MODEL ??
      firstExisting([
        path.resolve(process.cwd(), "../../reference/silero-vad/src/silero_vad/data/silero_vad.onnx"),
        path.resolve(process.cwd(), "reference/silero-vad/src/silero_vad/data/silero_vad.onnx"),
        path.join(HOME, "Projects/AI-meeting/reference/silero-vad/src/silero_vad/data/silero_vad.onnx"),
      ]),
    whisperServerUrl: env.WHISPER_SERVER_URL ?? "http://127.0.0.1:8178",
    llmUrl: env.LOCAL_LLM_URL ?? "http://127.0.0.1:8080/v1",
    llmModel: env.LOCAL_LLM_MODEL ?? "local",
    /**
     * Bearer token for the LLM endpoint. Empty for llama.cpp on this machine; set when the endpoint is
     * a cloud one — the local recogniser and the local voice are the parts worth keeping local, and a
     * 2B model is not. `strict_local` still refuses any non-loopback endpoint, key or no key.
     */
    llmKey: env.LOCAL_LLM_KEY ?? "",
    /** "none" for a thinking model that has to hold a conversation; unset for servers without it. */
    llmReasoning: env.LOCAL_LLM_REASONING ?? "",
    /**
     * A local llama.cpp runs with a 4k context, so recent turns get 2400 characters there; a cloud
     * endpoint has room for the whole evening. Either way, what scrolls out is folded into notes.
     */
    llmHistoryChars: Number(env.LOCAL_LLM_HISTORY_CHARS ?? (isLoopbackUrl(env.LOCAL_LLM_URL ?? "http://127.0.0.1:8080/v1") ? 2400 : 12000)),
    /**
     * A cloud model's slow starts are per request (see HedgedLLM), so a duplicate request after a
     * short wait is what keeps a reply under the conversational limit. 1.8 s: over ~290 turns of one
     * evening's soak the first token came in 0.67–1.32 s except for the stalls, which sat at 2.4 s and
     * far beyond — nothing in between worth waiting for, and every 100 ms spent waiting is 100 ms of
     * silence in the room after 「えーっと、」 (Gate #8 run 47: 4.0 s). A local llama.cpp serves one
     * request at a time — a second request there would queue behind the first and help nothing — so
     * it is off on loopback.
     */
    llmHedgeMs: Number(env.LOCAL_LLM_HEDGE_MS ?? (isLoopbackUrl(env.LOCAL_LLM_URL ?? "http://127.0.0.1:8080/v1") ? 0 : 1800)),
    /**
     * A 16 GB host with a 12 GB bot-host VM keeps the local model's 3 GB of weights only while they are
     * being used: after a quiet quarter of an hour the first request paged them back in at 150–250 ms
     * a token (Gate #8 runs 92–98: the pre-flight's 27 tokens in 4.8–6.7 s, the greeting's first token
     * 3.5 s). One one-token request every 45 s keeps them warm; a remote model is never touched.
     */
    llmKeepWarmMs: Number(env.LOCAL_LLM_KEEPWARM_MS ?? 45_000),
    dumpUtterancesDir: env.RCAI_DUMP_UTTERANCES || null,
    tts: (env.LOCAL_TTS as AgentConfig["tts"]) ?? "auto",
    /**
     * Meet's captions read the character's own 「Yuiです」 as 「ゆうです」 (run 98) and 「イです。ユーと…」
     * (run 101): the voice reads a Latin name a different way each time. "Yui=ゆい,Tester=テスター".
     */
    ttsReadings: Object.fromEntries((env.LOCAL_TTS_READINGS ?? "").split(",").map((kv) => kv.split("=").map((x) => x.trim())).filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1])),
    sbv2Url: env.SBV2_URL ?? "http://127.0.0.1:5000",
    sayVoice: env.SAY_VOICE ?? "Kyoko",
    avspeechVoice: env.AVSPEECH_VOICE ?? "com.apple.voice.compact.ja-JP.Kyoko",
    /** AivisSpeech Engine (VOICEVOX-compatible, local). Absent ⇒ BLOCKED_BY_AIVIS_SERVER and a fallback. */
    aivisUrl: env.AIVIS_URL ?? "http://127.0.0.1:10101",
    /** Supertonic 3 weights + the vendor's Node inference (scripts/fetch-supertonic.sh). */
    supertonicDir:
      env.SUPERTONIC_DIR ??
      firstExisting([
        path.resolve(process.cwd(), "../../vendor/supertonic"),
        path.resolve(process.cwd(), "vendor/supertonic"),
        path.join(HOME, "Projects/AI-meeting/vendor/supertonic"),
      ]) ??
      "",
    supertonicVoice: env.SUPERTONIC_VOICE ?? "F1",
    /**
     * Denoising steps. Measured on this Mac for 「はい、私はゆいです。」: 8 → 1305 ms, 4 → 690 ms,
     * 2 → 348 ms, 1 → 182 ms, all for the same 2.1 s of speech. 4 is the default because a character
     * that takes 1.3 s to start a sentence is a character people talk over.
     */
    supertonicSteps: Number(env.SUPERTONIC_STEPS ?? 4),
    supertonicSpeed: Number(env.SUPERTONIC_SPEED ?? 1.05),
    /**
     * "int8" halves synthesis time (1120 ms → 569 ms for the same 3.4 s) and the models drop from
     * 297 MB to 76 MB. Built locally by scripts/quantize-supertonic.sh — there is no int8 release —
     * and falls back to float when it has not been built.
     *
     * Default int8 since Gate #8 run 89: the agent had been running float (the env var was never
     * set at a restart) and the first phrase of a reply, 11 characters, took 1466 ms to synthesize
     * with the bot host on the same cores. Alone, F1 at 4 steps, 3 repeats each: 11 characters
     * float 389–471 ms / int8 180–186 ms, 30 characters float 774–845 ms / int8 334–351 ms; whisper
     * reads three int8 replies back verbatim (scratch tts-bench / tts-quality, 2026-09-05). CoreML
     * was tried and is slower (the graph splits into 35–165 partitions).
     */
    supertonicPrecision: (env.SUPERTONIC_PRECISION as "float" | "int8") ?? "int8",
    /**
     * ONNX Runtime intra-op threads. Its default spans all ten cores, efficiency cores included, and
     * each op waits for its slowest thread. Four (the performance cores) is faster alone (int8 F1, 4
     * steps: 15 characters 195→180 ms, 45 characters 410→360 ms) and under a saturated host — twelve
     * busy processes: 780→620 ms / 1640→1440 ms — which is what a reply faces while the bot's browser
     * renders (scratch tts-contention, 2026-09-05). 0 = runtime default.
     */
    supertonicThreads: Number(env.SUPERTONIC_THREADS ?? 4),
    aivisVoice: env.AIVIS_VOICE ?? "",
    /** Acoustic turn-end model (Pipecat Smart Turn v3). Absent ⇒ silence-only endpointing. */
    smartTurnModel:
      env.SMART_TURN_MODEL ??
      firstExisting([
        path.resolve(process.cwd(), "../../vendor/smart-turn/smart-turn-v3.0.onnx"),
        path.resolve(process.cwd(), "vendor/smart-turn/smart-turn-v3.0.onnx"),
        path.join(HOME, "Projects/AI-meeting/vendor/smart-turn/smart-turn-v3.0.onnx"),
      ]),
    turn: (env.LOCAL_TURN as "smart" | "off") ?? "smart",
    ttsDaemonPath:
      env.RCAI_TTS_DAEMON ??
      firstExisting([
        path.resolve(process.cwd(), "tools/tts-daemon/bin/rcai-tts-daemon"),
        path.resolve(process.cwd(), "../../tools/tts-daemon/bin/rcai-tts-daemon"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools/tts-daemon/bin/rcai-tts-daemon"),
      ]),
    vadMinSilenceMs: Number(env.VAD_MIN_SILENCE_MS ?? 400),
    sttMode: (env.LOCAL_STT_MODE as AgentConfig["sttMode"]) ?? "incremental",
    sherpaOnlineModelDir: env.SHERPA_ONLINE_MODEL_DIR ?? null,
    pauseMinSilenceMs: Number(env.PAUSE_MIN_SILENCE_MS ?? 200),
    sttIncrementalIntervalMs: Number(env.STT_INCREMENTAL_INTERVAL_MS ?? 300),
    endpoint: {
      minSilenceMs: Number(env.ENDPOINT_MIN_SILENCE_MS ?? 240),
      completeSilenceMs: Number(env.ENDPOINT_COMPLETE_SILENCE_MS ?? 320),
      unknownSilenceMs: Number(env.ENDPOINT_UNKNOWN_SILENCE_MS ?? 520),
      incompleteSilenceMs: Number(env.ENDPOINT_INCOMPLETE_SILENCE_MS ?? 800),
      maxSilenceMs: Number(env.ENDPOINT_MAX_SILENCE_MS ?? 900),
    },
    egressLog: env.RCAI_EGRESS_LOG === "1",
  };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
}

/** strict_local: every adapter endpoint must be loopback. Returns offending URLs. */
export function nonLoopbackEndpoints(cfg: AgentConfig): string[] {
  const urls = [cfg.llmUrl, cfg.whisperServerUrl, cfg.sbv2Url];
  return urls.filter((u) => !isLoopbackUrl(u));
}
