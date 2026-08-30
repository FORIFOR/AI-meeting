import { renderPolicy, type PromptAdapter } from "@rcai/conversation-core";

/**
 * OpenAI Realtime takes a single `instructions` string; it responds well to an explicit
 * spoken-style directive and a short rules block.
 */
export const openaiPromptAdapter: PromptAdapter = {
  providerId: "openai",
  adapt(systemPrompt, policy) {
    const ja = policy.language.toLowerCase().startsWith("ja");
    const lead = ja
      ? "あなたは音声で会話するキャラクターです。返答は必ず声に出して自然に話すように、短く。"
      : "You are a character speaking aloud in a live voice conversation. Reply briefly and naturally, as speech.";
    return `${lead}\n\n${systemPrompt.trim()}\n\n${renderPolicy(policy)}`;
  },
};
