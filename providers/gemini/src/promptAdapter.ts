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
      ? `必ず日本語（${policy.language}）で、音声として自然に短く話すこと。1回の返答は最大${policy.maxSentences}文。通常5〜10秒、詳しい説明を求められた場合以外は15秒以内を目安にする。`
      : `Always answer in ${policy.language}, spoken-style and brief: at most ${policy.maxSentences} sentences per reply. Usually speak for 5–10 seconds, within 15 seconds unless more detail is requested.`;
    return `${systemPrompt.trim()}\n\n${renderPolicy(policy)}\n\n${tail}`;
  },
};
