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

/**
 * The voice the character speaks with when the character pack names none.
 *
 * Kore is Google's "Firm" — a capable, businesslike voice, and the wrong first impression for a
 * character somebody is meant to want to talk to again (「現在の声はあまり好きじゃないです」,
 * 2026-09-07). "Friendly" is the safer default for a character used for half an hour at a time:
 * likeable without being a mascot. Google publishes no per-language ranking, so this is a starting
 * point to compare in Japanese, not a finding.
 */
export const DEFAULT_GEMINI_LIVE_VOICE = "Achird";
/**
 * The three worth comparing, with the character on screen and the same twenty lines: Achird
 * ("Friendly"), Leda ("Youthful"), Sulafat ("Warm"). The wider set — Kore ("Firm"), Iapetus
 * ("Clear"), Schedar ("Even"), Vindemiatrix ("Gentle"), Zephyr ("Bright") — stays selectable.
 */
export const GEMINI_LIVE_VOICES_TO_COMPARE = ["Achird", "Leda", "Sulafat"] as const;
/**
 * What a person choosing a voice actually picks between. The Google names mean nothing to them, so
 * the setting offers the character, not the vendor's catalogue.
 */
export const GEMINI_LIVE_VOICE_CHOICES = [
  { id: "friendly", voice: "Achird", label: "親しみやすい", detail: "自然で話しやすい" },
  { id: "youthful", voice: "Leda", label: "明るい", detail: "若々しく元気" },
  { id: "warm", voice: "Sulafat", label: "やさしい", detail: "落ち着いていて穏やか" },
  { id: "gentle", voice: "Vindemiatrix", label: "ていねい", detail: "柔らかく丁寧" },
  { id: "cool", voice: "Kore", label: "落ち着いた", detail: "知的でしっかりした" },
] as const;

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
    /**
     * How much the model thinks before it answers. 3.1 Flash Live's own default is "minimal", which is
     * what a meeting wants: a few hundred milliseconds of reasoning buys less than it costs in a
     * conversation where the reply has to start while the room is still listening.
     */
    thinkingConfig?: { thinkingLevel?: "minimal" | "standard" | "high" };
    temperature?: number;
    maxOutputTokens?: number;
  };
  systemInstruction?: GeminiContent;
  /**
   * Tools the model may use. `googleSearch` is the Live API's own grounding tool: with it the model
   * looks today's answer up instead of saying it cannot know. Everything else is our own functions.
   */
  tools?: ({ functionDeclarations: { name: string; description: string; parameters?: Record<string, unknown> }[] } | { googleSearch: Record<string, never> })[];
  realtimeInputConfig?: { automaticActivityDetection?: AutomaticActivityDetection; turnCoverage?: "TURN_INCLUDES_ONLY_ACTIVITY" | "TURN_INCLUDES_ALL_INPUT" };
  inputAudioTranscription?: Record<string, never>;
  outputAudioTranscription?: Record<string, never>;
  proactivity?: { proactiveAudio?: boolean };
  sessionResumption?: { handle?: string };
  contextWindowCompression?: { slidingWindow: { targetTokens?: string }; triggerTokens?: string };
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
