import { conversationPolicyFor, renderPolicy, type ConversationPolicy, type PrivacyMode, type SessionConfig } from "@rcai/conversation-core";
import type { CharacterDefinition } from "@rcai/avatar-core";
import type { Persona, SpeakingStyle } from "./persona.js";

export type ModeParams = Record<string, string | number | boolean>;

export function fillTemplate(template: string, params: ModeParams = {}, persona?: Persona): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => {
    const v = params[key];
    if (v !== undefined) return String(v);
    const def = persona?.params?.find((p) => p.key === key)?.default;
    return def ?? "";
  });
}

function renderStyle(style: SpeakingStyle, ja: boolean): string {
  const speed = { slow: ja ? "ゆっくり" : "slowly", normal: ja ? "普通の速さで" : "at a natural pace", fast: ja ? "テンポよく" : "briskly" }[style.speed];
  const pol = { casual: ja ? "くだけた口調（タメ口寄り）" : "casual", polite: ja ? "丁寧だが硬すぎない口調" : "polite but relaxed", formal: ja ? "フォーマルな敬語" : "formal" }[style.politeness];
  const energy = style.energy > 0.66 ? (ja ? "明るく元気に" : "upbeat") : style.energy > 0.33 ? (ja ? "落ち着いて温かく" : "warm and calm") : ja ? "静かに穏やかに" : "quiet and gentle";
  const len = style.sentenceLength === "short" ? (ja ? "1〜2文" : "one or two sentences") : ja ? "2〜3文" : "two or three sentences";
  const tone = style.tone ? (ja ? `声の雰囲気: ${style.tone}` : `Tone: ${style.tone}`) : "";
  return ja
    ? `【話し方】${speed}、${pol}、${energy}。基本は${len}で話す。${tone}`.trim()
    : `[Speaking style] Speak ${speed}, ${pol}, ${energy}. Keep replies to ${len}. ${tone}`.trim();
}

export interface BuildPromptInput {
  persona: Persona;
  character?: Pick<CharacterDefinition, "manifest"> | null;
  params?: ModeParams;
  policy?: ConversationPolicy;
  /** Extra runtime instructions (e.g. "the user is a beginner"). */
  extra?: string;
}

/**
 * Character + Persona + Conversation Policy → one system prompt (spec §18, §22).
 * Character supplies identity (name); Persona supplies personality/role; Policy supplies speech rules.
 */
export function buildSystemPrompt(input: BuildPromptInput): string {
  const { persona } = input;
  const ja = persona.language.toLowerCase().startsWith("ja");
  const policy = input.policy ?? conversationPolicyFor(persona.language);
  const name = input.character?.manifest.name;
  const identity = name ? (ja ? `あなたの名前は「${name}」です。` : `Your name is "${name}".`) : "";
  const role = fillTemplate(persona.systemPrompt, input.params, persona).trim();
  const turn = ja
    ? `【ターン】返答は最大${persona.turnPolicy.maxSentences}文。${persona.turnPolicy.backchannel ? "相手の話には短い相槌で反応する。" : ""}${persona.turnPolicy.correctionPolicy === "deferred" ? "会話中は細かい誤りを毎回指摘しない。指摘は数ターンに一度、まとめて短く。" : persona.turnPolicy.correctionPolicy === "none" ? "会話中に誤りを指摘しない。" : ""}`
    : `[Turns] At most ${persona.turnPolicy.maxSentences} sentences per reply. ${persona.turnPolicy.backchannel ? "React with brief backchannels." : ""} ${persona.turnPolicy.correctionPolicy === "deferred" ? "Do not correct every sentence; give brief, batched feedback only every few turns." : persona.turnPolicy.correctionPolicy === "none" ? "Do not correct mistakes during the conversation." : ""}`;
  const parts = [identity, role, renderStyle(persona.speakingStyle, ja), turn.trim(), renderPolicy(policy), input.extra?.trim() ?? ""];
  return parts.filter(Boolean).join("\n\n");
}

export interface CreateSessionConfigInput extends BuildPromptInput {
  providerId: "openai" | "google" | "local";
  privacyMode: PrivacyMode;
  character?: CharacterDefinition | null;
  model?: string;
}

/** Glue used by the app: persona + character + provider → SessionConfig (never contains secrets). */
export function createSessionConfig(input: CreateSessionConfigInput): SessionConfig {
  const voice = input.character?.voice.voices[input.providerId];
  return {
    systemPrompt: buildSystemPrompt(input),
    mode: input.persona.mode,
    language: input.persona.language,
    voice,
    model: input.model,
    privacyMode: input.privacyMode,
    characterId: input.character?.manifest.id,
    personaId: input.persona.id,
    providerOptions: {
      speakingStyle: input.persona.speakingStyle,
      turnPolicy: input.persona.turnPolicy,
      voiceStyle: input.character?.voice.style,
      opening: input.persona.opening ? fillTemplate(input.persona.opening, input.params, input.persona) : undefined,
    },
  };
}
