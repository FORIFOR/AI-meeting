/**
 * Spec §22: Japanese conversation policy applied to every provider.
 * Providers adapt wording through a PromptAdapter, but the rules themselves live here.
 */
export const JAPANESE_CONVERSATION_RULES: readonly string[] = [
  "書き言葉ではなく、自然な話し言葉で話す。",
  "返答は原則1〜3文。必要以上に長く話さない。",
  "毎ターン「なるほど」など同じ相槌を繰り返さない。",
  "ユーザーの発言を毎回要約・復唱しない。",
  "過剰な敬語や定型的な丁寧表現を避け、親しみやすく話す。",
  "質問は一度に一つだけにする。",
  "ユーザーが話している途中では割り込まない。話し終わるまで待つ。",
  "適度な沈黙を許容し、急いで埋めない。",
  "自然な相槌（うん、そうなんだ、へえ、など）を場面に合わせて使う。",
  "日付・数字・英単語は読み上げやすい形に正規化して話す（例: 2024年→二千二十四年、API→エーピーアイ）。",
];

export const ENGLISH_CONVERSATION_RULES: readonly string[] = [
  "Speak naturally, as in real conversation, not like written text.",
  "Keep replies to one to three sentences.",
  "Do not repeat the same backchannel every turn.",
  "Do not summarize or echo what the user just said.",
  "Ask at most one question at a time.",
  "Never interrupt while the user is still speaking.",
  "Allow short silences; do not rush to fill them.",
  "Normalize dates, numbers and acronyms for speech.",
];

export interface ConversationPolicy {
  language: string;
  rules: readonly string[];
  /** Hard cap hint for providers that support max output tokens. */
  maxSentences: number;
}

export function conversationPolicyFor(language: string): ConversationPolicy {
  const isJa = language.toLowerCase().startsWith("ja");
  return {
    language,
    rules: isJa ? JAPANESE_CONVERSATION_RULES : ENGLISH_CONVERSATION_RULES,
    maxSentences: 3,
  };
}

export function renderPolicy(policy: ConversationPolicy): string {
  const heading = policy.language.toLowerCase().startsWith("ja") ? "【会話ルール】" : "[Conversation rules]";
  return `${heading}\n${policy.rules.map((r) => `- ${r}`).join("\n")}`;
}

/**
 * PromptAdapter: each provider may reshape the instructions (e.g. Gemini prefers a
 * systemInstruction with short bullet points, OpenAI Realtime wants a single string).
 */
export interface PromptAdapter {
  providerId: string;
  adapt(systemPrompt: string, policy: ConversationPolicy): string;
}

export const identityPromptAdapter: PromptAdapter = {
  providerId: "generic",
  adapt: (prompt, policy) => `${prompt.trim()}\n\n${renderPolicy(policy)}`,
};
