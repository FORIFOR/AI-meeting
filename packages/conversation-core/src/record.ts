import type { ConversationMode, ProviderId } from "./session.js";

/** What the Evaluator sidecar consumes (spec §21) — never the raw audio by default (§26). */
export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  startedAt: number;
  endedAt: number;
  /** True when this assistant turn was cut by the user. */
  interrupted?: boolean;
}

export interface SessionRecord {
  sessionId: string;
  providerId: ProviderId | string;
  mode: ConversationMode;
  characterId?: string;
  personaId?: string;
  language: string;
  startedAt: number;
  endedAt?: number;
  turns: TranscriptTurn[];
  timing: {
    /** user_speech_ended -> assistant_speech_started samples in ms */
    responseLatenciesMs: number[];
    /** silences between assistant end and user start in ms */
    userSilencesMs: number[];
    userSpeechDurationsMs: number[];
    assistantSpeechDurationsMs: number[];
  };
  interruptions: {
    byUser: number;
    byAssistant: number;
  };
  audioMetrics: {
    /** Average mic level dBFS during user speech, if available. */
    userLevelDb?: number;
    frames: number;
  };
  metadata?: Record<string, string | number | boolean>;
}
