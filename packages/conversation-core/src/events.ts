import type { PCMFrame } from "@rcai/audio-core";

/** Tool call surfaced by a provider (function calling). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Generation epoch (Round 3 Gate 1). Every assistant-side event is stamped with the
 * generation that produced it; after an interruption the runtime, the audio sink, the avatar
 * and the UI all drop anything older than the accepted generation, so a late chunk can never
 * re-activate audio, captions, speaking state or lip motion.
 */
export interface GenerationRef {
  sessionId: string;
  /** User turn counter (provider-owned, monotonic within a session). */
  turnId: number;
  /** Assistant generation counter (provider-owned, monotonic; +1 per response/cancel). */
  generationId: number;
  /** Event sequence within the generation. */
  sequence: number;
}

/** Per-turn latency breakdown reported by a provider that can measure its own pipeline (local agent). */
export interface TurnMetrics {
  /** speech_end sample fed → VAD end decision (ms) */
  vadEndMs?: number;
  /** VAD decision → final transcript (ms) */
  sttMs?: number;
  /** LLM request → first token (ms) */
  llmTtftMs?: number;
  /** LLM request → first speakable phrase (ms) */
  firstPhraseMs?: number;
  /** first phrase ready → first TTS audio bytes (ms) */
  ttsTtfaMs?: number;
  /** speech_end → first audio chunk on the wire (ms) */
  firstAudioSentMs?: number;
  /** speech_end → last audio chunk sent (ms) */
  totalMs?: number;
  phrases?: number;
  sentences?: number;
  engines?: { vad?: string; stt?: string; llm?: string; tts?: string };
  /** Text-input turns have no VAD/STT stage. */
  source?: "speech" | "text";
  // ---- Round 3 (Gate 3/4): endpointing + streaming STT (additive) ----
  /** Why the turn endpoint fired ("punct", "final_form", "max_silence", "baseline_vad", …). */
  endpointReason?: string;
  /** Silence (ms) the policy required before ending the turn. */
  endpointSilenceMs?: number;
  /** True end of user audio (VAD segment end) → first audio chunk on the wire (ms) — the user-perceived KPI. */
  endToFirstAudioMs?: number;
  /** The final transcript was served from a fresh incremental partial (no post-end decode). */
  sttReused?: boolean;
  /** Number of incremental partial decodes during the utterance. */
  sttPartials?: number;
  /** The previous turn ended prematurely (user resumed < 1.2 s after the endpoint); this turn merged the text. */
  prematureEndpoint?: boolean;
  /** Session running totals. */
  session?: { turns: number; prematureEndpoints: number; prematureEndpointRate: number; bargeIns: number; userBargeInRate: number };
}

/**
 * Unified Events (spec §4). Every provider maps its native events to this union;
 * UI / Avatar / Evaluator never see provider-specific payloads.
 */
export type ConversationEvent =
  | { type: "session_ready"; providerId: string }
  | { type: "session_closed"; reason?: string }
  | { type: "user_speech_started"; at?: number }
  | { type: "user_speech_ended"; at?: number }
  | { type: "user_transcript"; text: string; final?: boolean; id?: number; delta?: boolean }
  /**
   * A better reading of an utterance already delivered as a final `user_transcript` (`id` matches).
   * Context only: it replaces the text a later turn will see, and never earns a turn of its own — the
   * turn decision was made on the first reading, at the speed a conversation needs.
   */
  | { type: "user_transcript_revised"; id: number; text: string }
  | { type: "assistant_thinking"; gen?: GenerationRef }
  | { type: "assistant_speech_started"; at?: number; gen?: GenerationRef }
  | { type: "assistant_audio"; frame: PCMFrame; gen?: GenerationRef }
  | { type: "assistant_transcript"; text: string; final?: boolean; gen?: GenerationRef }
  | { type: "assistant_speech_ended"; at?: number; gen?: GenerationRef }
  | { type: "interrupted"; at?: number; gen?: GenerationRef }
  | { type: "tool_call"; call: ToolCall; gen?: GenerationRef }
  | { type: "usage"; provider: string; model: string; at: number; counters: Record<string, number> }
  | { type: "metrics"; turn: TurnMetrics; gen?: GenerationRef }
  | { type: "error"; error: Error; fatal?: boolean };

export type ConversationEventType = ConversationEvent["type"];

/** Events that belong to an assistant generation (subject to stale-generation dropping). */
export const GENERATION_EVENT_TYPES: ReadonlySet<ConversationEventType> = new Set([
  "assistant_thinking",
  "assistant_speech_started",
  "assistant_audio",
  "assistant_transcript",
  "assistant_speech_ended",
  "tool_call",
  "metrics",
]);

/** Small helper for providers: a per-session generation counter. */
export class GenerationCounter {
  private turnId = 0;
  private generationId = 0;
  private sequence = 0;
  constructor(readonly sessionId: string = `g_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`) {}
  /** Start a new user turn (optional; generations may span turns). */
  nextTurn(): number {
    return ++this.turnId;
  }
  /** Start a new assistant generation (also used after a cancel so late chunks are distinguishable). */
  nextGeneration(): GenerationRef {
    this.generationId++;
    this.sequence = 0;
    return this.current();
  }
  /** Stamp for the next event of the current generation (sequence increments). */
  stamp(): GenerationRef {
    return { sessionId: this.sessionId, turnId: this.turnId, generationId: this.generationId, sequence: this.sequence++ };
  }
  current(): GenerationRef {
    return { sessionId: this.sessionId, turnId: this.turnId, generationId: this.generationId, sequence: this.sequence };
  }
  get generation(): number {
    return this.generationId;
  }
}

export type ConversationEventListener = (event: ConversationEvent) => void;
