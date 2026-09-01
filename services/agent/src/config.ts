import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export interface AgentConfig {
  port: number;
  stt: "sherpa" | "whisper";
  /** Second pass over the committed utterance with a stronger model: "whisper" or "off" (default). */
  sttFinal: "whisper" | "off";
  sherpaModelDir: string | null;
  sileroVadModel: string | null;
  whisperServerUrl: string;
  llmUrl: string;
  llmModel: string;
  tts: "say" | "sbv2" | "avspeech" | "auto";
  sbv2Url: string;
  sayVoice: string;
  /** AVSpeechSynthesisVoice identifier for the resident daemon (tools/tts-daemon). */
  avspeechVoice: string;
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
    tts: (env.LOCAL_TTS as AgentConfig["tts"]) ?? "auto",
    sbv2Url: env.SBV2_URL ?? "http://127.0.0.1:5000",
    sayVoice: env.SAY_VOICE ?? "Kyoko",
    avspeechVoice: env.AVSPEECH_VOICE ?? "com.apple.voice.compact.ja-JP.Kyoko",
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
