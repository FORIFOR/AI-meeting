/**
 * Gemini Live API (BidiGenerateContent) wire shapes.
 * Field names verified against https://ai.google.dev/api/live and
 * https://ai.google.dev/gemini-api/docs/live-guide (2026-08-30). See docs/reports/gate5-gemini.md.
 */

export const GEMINI_WSS_BASE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage";
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
export const GEMINI_INPUT_RATE = 16_000;
export const GEMINI_OUTPUT_RATE = 24_000;

export interface GeminiPart {
  text?: string;
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

export function geminiWssUrl(apiVersion: "v1beta" | "v1alpha", ephemeralToken: string): string {
  return `${GEMINI_WSS_BASE}.${apiVersion}.GenerativeService.BidiGenerateContent?access_token=${encodeURIComponent(ephemeralToken)}`;
}

export function parsePcmRate(mimeType: string, fallback = GEMINI_OUTPUT_RATE): number {
  const m = /rate=(\d+)/.exec(mimeType);
  return m ? Number(m[1]) : fallback;
}
