import type { EvaluationInput, EvaluationResult } from "@rcai/provider-core";
import type { LLMAdapter } from "./adapters/llm.js";

/**
 * Bridge to @rcai/evaluation (built concurrently by another workstream). Uses its LLM-backed
 * evaluator against the local LLM when available; otherwise a transparent heuristic scorer.
 * Never touches the network beyond the loopback LLM.
 */
export async function evaluateLocally(input: EvaluationInput, llm: LLMAdapter | null, llmUrl: string): Promise<EvaluationResult> {
  try {
    const mod = (await import("@rcai/evaluation")) as Record<string, unknown>;
    if (llm?.ready && typeof mod.evaluateWithOpenAICompatible === "function") {
      const fn = mod.evaluateWithOpenAICompatible as (cfg: { baseUrl: string; model: string; fetch?: typeof fetch }, input: EvaluationInput) => Promise<EvaluationResult>;
      const r = await fn({ baseUrl: llmUrl, model: llm.model }, input);
      return { ...r, evaluatedBy: r.evaluatedBy ?? `local:${llm.model}` };
    }
    if (typeof mod.HeuristicEvaluator === "function") {
      const H = mod.HeuristicEvaluator as new () => { evaluate(i: EvaluationInput): Promise<EvaluationResult> };
      return new H().evaluate(input);
    }
  } catch {
    /* fall through */
  }
  return heuristicEvaluate(input);
}

/** Minimal offline scorer used until @rcai/evaluation is available. */
export function heuristicEvaluate(input: EvaluationInput): EvaluationResult {
  const user = input.transcript.filter((t) => t.role === "user").map((t) => t.text);
  const words = user.join(" ");
  const len = words.length;
  const fillers = (words.match(/(えっと|あの|えー|うーん|um|uh|like)/g) ?? []).length;
  const structure = /(結論|まず|次に|理由|例えば|最後に|first|second|because|for example)/.test(words) ? 85 : 60;
  const specificity = /\d/.test(words) || /(具体的|例えば|プロジェクト|案件)/.test(words) ? 78 : 55;
  const clarity = Math.max(40, Math.min(95, 90 - fillers * 4));
  const lat = input.timing.responseLatenciesMs;
  const fluency = Math.max(40, Math.min(95, 85 - input.interruptions.byUser * 3 - (input.timing.userSilencesMs.filter((s) => s > 3000).length) * 5));
  const relevance = len > 40 ? 75 : 55;
  const overall = Math.round((clarity + specificity + structure + relevance + fluency) / 5);
  return {
    overall, clarity, specificity, structure, relevance, fluency,
    feedback: [
      fillers > 3 ? `フィラー（えっと・あの）が${fillers}回ありました。間を置いて話すと聞きやすくなります。` : "フィラーは少なく、聞き取りやすい話し方でした。",
      structure < 70 ? "結論→理由→具体例の順で話すと構造が伝わりやすくなります。" : "話の構造は明確でした。",
      lat.length ? `平均応答間隔 ${(lat.reduce((a, b) => a + b, 0) / lat.length / 1000).toFixed(1)} 秒。` : "",
    ].filter(Boolean),
    improvedAnswer: "",
    evaluatedBy: "local:heuristic",
  };
}
