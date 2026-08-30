import type { ImageFrame, PCMFrame } from "@rcai/audio-core";
import type {
  ConversationContext,
  ConversationEventListener,
  ConversationSource,
  PrivacyMode,
  ProviderId,
  SessionConfig,
} from "@rcai/conversation-core";

/** Spec §3 */
export interface ProviderCapabilities {
  nativeAudio: boolean;
  vision: boolean;
  toolCalling: boolean;
  realtimeTranscript: boolean;
  interruption: boolean;
  emotionUnderstanding: boolean;
  localOnly: boolean;
  /** Provider-specific extras surfaced as flags (e.g. Gemini proactive audio / affective dialog). */
  extras?: Record<string, boolean>;
}

/** Spec §3: common realtime AI interface. */
export interface RealtimeAIProvider extends ConversationSource {
  id: ProviderId;
  capabilities(): ProviderCapabilities;
  connect(config: SessionConfig): Promise<void>;
  pushAudio(frame: PCMFrame): void;
  pushImage?(image: ImageFrame): void;
  sendText(text: string): Promise<void>;
  interrupt(): Promise<void>;
  updateContext(context: ConversationContext): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(callback: ConversationEventListener): void;
}

// ---- Evaluation ---------------------------------------------------------

export interface EvaluationInput {
  mode: string;
  language: string;
  /** Persona's evaluationProfile id (e.g. "interview_standard"). */
  evaluationProfile?: string;
  transcript: { role: "user" | "assistant"; text: string; interrupted?: boolean }[];
  timing: {
    responseLatenciesMs: number[];
    userSilencesMs: number[];
    userSpeechDurationsMs: number[];
    assistantSpeechDurationsMs: number[];
  };
  interruptions: { byUser: number; byAssistant: number };
  audioMetrics?: { userLevelDb?: number };
  /** Mode-specific parameters (position, company style, lesson type...). */
  params?: Record<string, string | number | boolean>;
}

/** Spec §21 result shape. */
export interface EvaluationResult {
  overall: number;
  clarity: number;
  specificity: number;
  structure: number;
  relevance: number;
  fluency: number;
  feedback: string[];
  improvedAnswer: string;
  /** Which provider produced it. */
  evaluatedBy?: string;
}

export interface EvaluationProvider {
  id: ProviderId;
  evaluate(input: EvaluationInput): Promise<EvaluationResult>;
}

// ---- STT / Vision ------------------------------------------------------

export interface STTResult {
  text: string;
  final: boolean;
  language?: string;
  confidence?: number;
}

export interface STTProvider {
  id: ProviderId;
  /** Streaming: push frames, get partial + final results. */
  start(opts: { language: string }): Promise<void>;
  pushAudio(frame: PCMFrame): void;
  /** Force an end-of-utterance. */
  endUtterance(): Promise<STTResult | null>;
  onResult(cb: (r: STTResult) => void): void;
  stop(): Promise<void>;
}

export interface VisionProvider {
  id: ProviderId;
  describe(image: ImageFrame, prompt?: string): Promise<string>;
}

// ---- Privacy -----------------------------------------------------------

export type EgressTarget =
  | "livekit_cloud"
  | "cloud_stt"
  | "cloud_tts"
  | "cloud_evaluator"
  | "cloud_conversation"
  | "cloud_vision"
  | "telemetry_body";

export class PrivacyViolationError extends Error {
  constructor(readonly target: EgressTarget) {
    super(`privacyMode=strict_local forbids ${target}`);
    this.name = "PrivacyViolationError";
  }
}

/** Spec §6: strict_local blocks every cloud egress. */
export const privacyGuard = {
  isAllowed(mode: PrivacyMode, target: EgressTarget): boolean {
    return mode !== "strict_local";
  },
  assert(mode: PrivacyMode, target: EgressTarget): void {
    if (!privacyGuard.isAllowed(mode, target)) throw new PrivacyViolationError(target);
  },
  /** Strip transcript bodies from telemetry payloads under strict_local. */
  sanitizeTelemetry<T extends Record<string, unknown>>(mode: PrivacyMode, payload: T): Partial<T> {
    if (mode !== "strict_local") return payload;
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === "string" && v.length > 32) continue; // body-like strings dropped
      if (/text|transcript|prompt|content/i.test(k)) continue;
      (out as Record<string, unknown>)[k] = v;
    }
    return out;
  },
};
