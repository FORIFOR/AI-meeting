import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";
import { isLoopbackUrl } from "./loopback.js";

export interface LocalEvaluationOptions {
  agentUrl: string;
  fetchImpl?: typeof fetch;
}

/** Evaluator sidecar served by the local agent (`POST /evaluate`). Never leaves the machine. */
export function createLocalEvaluationProvider(opts: LocalEvaluationOptions): EvaluationProvider {
  const f = opts.fetchImpl ?? fetch;
  const base = opts.agentUrl.replace(/^ws/, "http").replace(/\/$/, "");
  return {
    id: "local",
    async evaluate(input: EvaluationInput): Promise<EvaluationResult> {
      if (!isLoopbackUrl(base)) throw new Error("local evaluator requires a loopback agent URL");
      const res = await f(`${base}/evaluate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!res.ok) throw new Error(`local evaluate ${res.status}`);
      const r = (await res.json()) as EvaluationResult;
      return { ...r, evaluatedBy: r.evaluatedBy ?? "local" };
    },
  };
}
