import { renderPolicy, type PromptAdapter } from "@rcai/conversation-core";

/**
 * Gemini native-audio models auto-detect language and tend to produce long turns,
 * so the adapter pins the response language and repeats the brevity rule last
 * (recency bias helps the Live model honour it).
 */
export const geminiPromptAdapter: PromptAdapter = {
  providerId: "google",
  adapt(systemPrompt, policy) {
    const ja = policy.language.toLowerCase().startsWith("ja");
    const tail = ja
      ? `必ず日本語（${policy.language}）で、音声として自然に短く話すこと。1回の返答は最大${policy.maxSentences}文。`
      : `Always answer in ${policy.language}, spoken-style and brief: at most ${policy.maxSentences} sentences per reply.`;
    return `${systemPrompt.trim()}\n\n${renderPolicy(policy)}\n\n${tail}`;
  },
};
