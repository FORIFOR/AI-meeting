/**
 * Gemini Live API (BidiGenerateContent) wire shapes.
 * Field names verified against https://ai.google.dev/api/live and
 * https://ai.google.dev/gemini-api/docs/live-guide (2026-08-30). See docs/reports/gate5-gemini.md.
 */

export const GEMINI_WSS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";
/**
 * Measured on the same 3-minute spoken soak: this model answers at p50 1144 ms / p95 1414 ms with 21/21
 * utterances heard, against 3985 / 8929 ms and 18/21 for `gemini-2.5-flash-native-audio-preview-12-2025`.
 * Latency was never the transport — it was the model.
 */
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
export const GEMINI_INPUT_RATE = 16_000;
export const GEMINI_OUTPUT_RATE = 24_000;

export interface GeminiPart {
  text?: string;
  /** Native-audio models emit their reasoning as ordinary text parts flagged this way. */
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
}

export interface GeminiContent {
  role?: "user" | "model";
  parts: GeminiPart[];
}

export interface AutomaticActivityDetection {
  disabled?: boolean;
  startOfSpeechSensitivity?: "START_SENSITIVITY_UNSPECIFIED" | "START_SENSITIVITY_HIGH" | "START_SENSITIVITY_LOW";
  endOfSpeechSensitivity?: "END_SENSITIVITY_UNSPECIFIED" | "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW";
  prefixPaddingMs?: number;
  silenceDurationMs?: number;
}

export interface GeminiSetup {
  model: string;
  generationConfig?: {
    responseModalities?: ("AUDIO" | "TEXT")[];
    speechConfig?: {
      voiceConfig?: { prebuiltVoiceConfig?: { voiceName: string } };
      languageCode?: string;
    };
    /** Maps from the SDK's `enableAffectiveDialog` (v1beta). */
    enableAffectiveDialog?: boolean;
    temperature?: number;
    maxOutputTokens?: number;
  };
  systemInstruction?: GeminiContent;
  tools?: { functionDeclarations: { name: string; description: string; parameters?: Record<string, unknown> }[] }[];
  realtimeInputConfig?: { automaticActivityDetection?: AutomaticActivityDetection };
  inputAudioTranscription?: Record<string, never>;
  outputAudioTranscription?: Record<string, never>;
  proactivity?: { proactiveAudio?: boolean };
  sessionResumption?: { handle?: string };
}

export type GeminiClientMessage =
  | { setup: GeminiSetup }
  | { clientContent: { turns?: GeminiContent[]; turnComplete?: boolean } }
  | {
      realtimeInput: {
        audio?: { data: string; mimeType: string };
        video?: { data: string; mimeType: string };
        text?: string;
        activityStart?: Record<string, never>;
        activityEnd?: Record<string, never>;
        audioStreamEnd?: boolean;
      };
    }
  | { toolResponse: { functionResponses: { id?: string; name: string; response: Record<string, unknown> }[] } };

export interface GeminiServerContent {
  modelTurn?: GeminiContent;
  turnComplete?: boolean;
  interrupted?: boolean;
  generationComplete?: boolean;
  inputTranscription?: { text?: string; finished?: boolean };
  outputTranscription?: { text?: string; finished?: boolean };
}

export interface GeminiServerMessage {
  setupComplete?: Record<string, unknown>;
  serverContent?: GeminiServerContent;
  toolCall?: { functionCalls?: { id?: string; name: string; args?: Record<string, unknown> }[] };
  toolCallCancellation?: { ids?: string[] };
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  usageMetadata?: Record<string, unknown>;
  error?: { message?: string; code?: number };
}

/**
 * Live endpoint for an EPHEMERAL token. The plain `BidiGenerateContent` method only accepts a real API
 * key: an ephemeral token there is refused with 1008 "Method doesn't allow unregistered callers", which
 * reads like a bad credential but is really the wrong method. Tokens carrying a `bidiGenerateContentSetup`
 * constraint belong on `BidiGenerateContentConstrained`.
 *
 * Note the socket opens whatever you send — Google authenticates on the first frame — so a connectivity
 * check that never sends `setup` will happily "pass" against the wrong endpoint.
 */
export function geminiWssUrl(apiVersion: "v1beta" | "v1alpha", ephemeralToken: string): string {
  return `${GEMINI_WSS_BASE}.${apiVersion}.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(ephemeralToken)}`;
}

export function parsePcmRate(mimeType: string, fallback = GEMINI_OUTPUT_RATE): number {
  const m = /rate=(\d+)/.exec(mimeType);
  return m ? Number(m[1]) : fallback;
}
