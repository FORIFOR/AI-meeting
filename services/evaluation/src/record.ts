import type { SessionRecord } from "@rcai/conversation-core";
import type { EvaluationInput } from "@rcai/provider-core";

/** SessionRecord (conversation runtime) → EvaluationInput (spec §21). Audio bodies are never included. */
export function sessionRecordToEvaluationInput(
  record: SessionRecord,
  params?: Record<string, string | number | boolean>,
  evaluationProfile?: string,
): EvaluationInput {
  return {
    mode: record.mode,
    language: record.language,
    evaluationProfile: evaluationProfile ?? defaultProfileForMode(record.mode),
    transcript: record.turns.map((t) => ({ role: t.role, text: t.text, ...(t.interrupted ? { interrupted: true } : {}) })),
    timing: {
      responseLatenciesMs: [...record.timing.responseLatenciesMs],
      userSilencesMs: [...record.timing.userSilencesMs],
      userSpeechDurationsMs: [...record.timing.userSpeechDurationsMs],
      assistantSpeechDurationsMs: [...record.timing.assistantSpeechDurationsMs],
    },
    interruptions: { ...record.interruptions },
    audioMetrics: record.audioMetrics.userLevelDb !== undefined ? { userLevelDb: record.audioMetrics.userLevelDb } : undefined,
    params: { ...(record.metadata ?? {}), ...(params ?? {}) },
  };
}

export type EvaluationProfile = "interview_standard" | "english_conversation" | "sales_roleplay" | "free_talk";

export function defaultProfileForMode(mode: string): EvaluationProfile {
  switch (mode) {
    case "interview":
      return "interview_standard";
    case "english_lesson":
      return "english_conversation";
    case "sales_roleplay":
      return "sales_roleplay";
    default:
      return "free_talk";
  }
}

export function resolveProfile(input: Pick<EvaluationInput, "mode" | "evaluationProfile">): EvaluationProfile {
  const p = input.evaluationProfile;
  if (p === "interview_standard" || p === "english_conversation" || p === "sales_roleplay" || p === "free_talk") return p;
  return defaultProfileForMode(input.mode);
}
