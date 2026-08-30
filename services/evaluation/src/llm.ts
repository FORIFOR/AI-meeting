import type { EvaluationInput, EvaluationResult } from "@rcai/provider-core";
import { buildEvaluationPrompt, EVALUATION_GEMINI_SCHEMA, EvaluationParseError, parseEvaluationResult } from "./prompt.js";

export type EvaluationErrorKind = "config" | "http" | "timeout" | "parse" | "network";

export class EvaluationError extends Error {
  constructor(readonly kind: EvaluationErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "EvaluationError";
  }
}

export interface OpenAICompatibleConfig {
  /** e.g. https://api.openai.com/v1 or http://127.0.0.1:8080/v1 (llama.cpp / Ollama / vLLM / MLX). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } catch (e) {
    if (ctrl.signal.aborted) throw new EvaluationError("timeout", `evaluation timed out after ${ms}ms`);
    if (e instanceof EvaluationError || e instanceof EvaluationParseError) throw e;
    throw new EvaluationError("network", (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Chat-completions evaluator. Tries JSON mode (`response_format: json_object`); if the
 * server rejects it (400), retries with prompt-only JSON. Never fabricates a result.
 */
export async function evaluateWithOpenAICompatible(config: OpenAICompatibleConfig, input: EvaluationInput): Promise<EvaluationResult> {
  if (!config.baseUrl || !config.model) throw new EvaluationError("config", "baseUrl and model are required");
  const f = config.fetch ?? fetch;
  const prompt = buildEvaluationPrompt(input);
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const body = (jsonMode: boolean) => ({
    model: config.model,
    temperature: config.temperature ?? 0.2,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  return withTimeout(config.timeoutMs ?? 60_000, async (signal) => {
    let res = await f(url, { method: "POST", headers, body: JSON.stringify(body(true)), signal });
    if (res.status === 400) {
      // Some local servers reject response_format; retry plain.
      res = await f(url, { method: "POST", headers, body: JSON.stringify(body(false)), signal });
    }
    if (!res.ok) throw new EvaluationError("http", `evaluation request failed: ${res.status} ${await safeText(res)}`, res.status);
    const json = (await res.json()) as { choices?: { message?: { content?: string | null } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new EvaluationError("parse", "empty completion");
    try {
      return parseEvaluationResult(content, `openai-compatible:${config.model}`, input);
    } catch (e) {
      throw new EvaluationError("parse", (e as Error).message);
    }
  });
}

export interface GeminiConfig {
  apiKey: string;
  /** e.g. gemini-2.5-flash */
  model: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  baseUrl?: string;
}

/** Gemini generateContent with structured output (responseMimeType + responseSchema). */
export async function evaluateWithGemini(config: GeminiConfig, input: EvaluationInput): Promise<EvaluationResult> {
  if (!config.apiKey) throw new EvaluationError("config", "BLOCKED_BY_GEMINI_KEY");
  if (!config.model) throw new EvaluationError("config", "model is required");
  const f = config.fetch ?? fetch;
  const prompt = buildEvaluationPrompt(input);
  const base = (config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
  const url = `${base}/models/${encodeURIComponent(config.model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: prompt.system }] },
    contents: [{ role: "user", parts: [{ text: prompt.user }] }],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "application/json",
      responseSchema: EVALUATION_GEMINI_SCHEMA,
    },
  };
  return withTimeout(config.timeoutMs ?? 60_000, async (signal) => {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey }, body: JSON.stringify(body), signal });
    if (!res.ok) throw new EvaluationError("http", `gemini evaluation failed: ${res.status} ${await safeText(res)}`, res.status);
    const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text.trim()) throw new EvaluationError("parse", "empty gemini response");
    try {
      return parseEvaluationResult(text, `gemini:${config.model}`, input);
    } catch (e) {
      throw new EvaluationError("parse", (e as Error).message);
    }
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
