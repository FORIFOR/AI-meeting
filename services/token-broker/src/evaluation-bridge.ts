import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";

/**
 * Contract names from docs/integration-contracts.md (implemented in services/evaluation by another gate).
 * Loaded dynamically so the broker typechecks/runs even before that package lands; falls back to a
 * transparent heuristic that is clearly labelled `evaluatedBy: "heuristic-fallback"`.
 */
export interface EvaluationModule {
  evaluateWithOpenAICompatible(cfg: { baseUrl: string; apiKey?: string; model: string; fetch?: typeof fetch }, input: EvaluationInput): Promise<EvaluationResult>;
  evaluateWithGemini(cfg: { apiKey: string; model: string; fetch?: typeof fetch }, input: EvaluationInput): Promise<EvaluationResult>;
  HeuristicEvaluator: new () => EvaluationProvider;
}

let cached: Partial<EvaluationModule> | null = null;

export async function loadEvaluationModule(): Promise<Partial<EvaluationModule>> {
  if (cached) return cached;
  try {
    cached = (await import("@rcai/evaluation")) as unknown as Partial<EvaluationModule>;
  } catch {
    cached = {};
  }
  return cached;
}

/** Minimal transparent fallback used only when @rcai/evaluation is unavailable. */
export function fallbackHeuristic(input: EvaluationInput): EvaluationResult {
  const user = input.transcript.filter((t) => t.role === "user");
  const words = user.reduce((n, t) => n + t.text.trim().length, 0);
  const avgLen = user.length ? words / user.length : 0;
  const specificity = Math.min(100, Math.round(30 + avgLen));
  const structure = Math.min(100, Math.round(40 + user.filter((t) => /(まず|次に|最後に|理由|例えば|first|second|because|for example)/i.test(t.text)).length * 15));
  const fluency = Math.max(0, 90 - input.interruptions.byUser * 5 - Math.round((input.timing.userSilencesMs.filter((s) => s > 3000).length) * 5));
  const clarity = Math.min(100, Math.round(50 + Math.min(40, avgLen / 3)));
  const relevance = user.length ? 70 : 0;
  const overall = Math.round((clarity + specificity + structure + relevance + fluency) / 5);
  return { overall, clarity, specificity, structure, relevance, fluency, feedback: ["(heuristic fallback: @rcai/evaluation not loaded)"], improvedAnswer: "", evaluatedBy: "heuristic-fallback" };
}
