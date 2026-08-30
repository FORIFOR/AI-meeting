import { privacyGuard, type EvaluationInput, type EvaluationProvider, type EvaluationResult } from "@rcai/provider-core";
import type { PrivacyMode } from "@rcai/conversation-core";

export interface BrokerEvaluationOptions {
  brokerUrl: string;
  fetch?: typeof fetch;
  privacyMode?: PrivacyMode;
}

/** Spec §21: cloud Evaluator via the broker (server holds the key). */
export function createOpenAIEvaluationProvider(opts: BrokerEvaluationOptions): EvaluationProvider {
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    id: "openai",
    async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
      privacyGuard.assert(opts.privacyMode ?? "default", "cloud_evaluator");
      const res = await fetchImpl(`${opts.brokerUrl.replace(/\/$/, "")}/api/evaluate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "openai", input }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `evaluate ${res.status}`);
      }
      const json = (await res.json()) as EvaluationResult;
      return { ...json, evaluatedBy: json.evaluatedBy ?? "openai" };
    },
  };
}
