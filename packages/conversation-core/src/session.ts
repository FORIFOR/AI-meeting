export type ProviderId = "openai" | "google" | "local";

/** Spec §6: strict_local forbids any cloud egress. */
export type PrivacyMode = "default" | "strict_local";

export type ConversationMode =
  | "free_talk"
  | "interview"
  | "english_lesson"
  | "sales_roleplay"
  | "tutor"
  | "career"
  /** Personal, unstructured conversation with someone close — company rather than practice. */
  | "companion"
  /** Thinking out loud about what has to be done: the character listens, keeps the list, helps choose the first step. */
  | "task_planning";

export interface TurnHistoryItem {
  role: "user" | "assistant";
  text: string;
  at: number;
}

/** Context that can be updated mid-session (spec RealtimeAIProvider.updateContext). */
export interface ConversationContext {
  systemPrompt: string;
  mode: ConversationMode;
  language: string;
  history?: TurnHistoryItem[];
  metadata?: Record<string, string | number | boolean>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SessionConfig {
  /** Fully-built instructions (persona + conversation policy + mode params). */
  systemPrompt: string;
  mode: ConversationMode;
  /** BCP-47, e.g. ja-JP. */
  language: string;
  /** Provider-specific voice id resolved from the character's VoiceProfile. */
  voice?: string;
  /** Optional model override. */
  model?: string;
  privacyMode: PrivacyMode;
  tools?: ToolDefinition[];
  /** Character id + persona id are kept for metadata / evaluation, never sent as secrets. */
  characterId?: string;
  personaId?: string;
  /** Extra provider options (never API keys). */
  providerOptions?: Record<string, unknown>;
}
