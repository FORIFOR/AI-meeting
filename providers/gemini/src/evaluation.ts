import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";
import { privacyGuard } from "@rcai/provider-core";
import type { PrivacyMode } from "@rcai/conversation-core";

export interface GeminiEvaluationOptions {
  brokerUrl: string;
  fetchImpl?: typeof fetch;
  privacyMode?: PrivacyMode;
}

/** Spec §21: evaluation via the token broker (`POST /api/evaluate`, providerId "google"). Keys never reach the client. */
export function createGeminiEvaluationProvider(opts: GeminiEvaluationOptions): EvaluationProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return {
    id: "google",
    async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
      privacyGuard.assert(opts.privacyMode ?? "default", "cloud_evaluator");
      const res = await fetchImpl(`${opts.brokerUrl.replace(/\/$/, "")}/api/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId: "google", input }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`gemini evaluation failed: ${res.status} ${body}`);
      }
      const result = (await res.json()) as EvaluationResult;
      return { ...result, evaluatedBy: result.evaluatedBy ?? "google" };
    },
  };
}
