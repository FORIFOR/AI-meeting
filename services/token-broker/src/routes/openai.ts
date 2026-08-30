import type { BrokerEnv } from "../env.js";

export const OPENAI_CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
export const OPENAI_REALTIME_BASE_URL = "https://api.openai.com/v1/realtime";

export interface OpenAITokenRequest {
  model?: string;
  voice?: string;
  instructions?: string;
  language?: string;
}

export interface OpenAITokenResponse {
  clientSecret: string;
  expiresAt: number;
  model: string;
  baseUrl: string;
}

export type RouteResult<T> = { status: number; body: T | { error: string; detail?: string } };

/**
 * POST https://api.openai.com/v1/realtime/client_secrets
 * (verified 2026-08-30: developers.openai.com/api/docs/guides/realtime-webrtc,
 *  .../api-reference/realtime-sessions/create-realtime-client-secret)
 */
export async function createOpenAIClientSecret(env: BrokerEnv, req: OpenAITokenRequest, fetchImpl: typeof fetch): Promise<RouteResult<OpenAITokenResponse>> {
  if (!env.OPENAI_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_OPENAI_KEY" } };
  const model = req.model ?? env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
  const session: Record<string, unknown> = { type: "realtime", model };
  if (req.instructions) session.instructions = req.instructions;
  const audio: Record<string, unknown> = {
    input: {
      transcription: { model: "gpt-live-transcribe", ...(req.language ? { languages: [req.language.split("-")[0]] } : {}) },
      turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true },
    },
  };
  if (req.voice) audio.output = { voice: req.voice };
  session.audio = audio;
  const res = await fetchImpl(OPENAI_CLIENT_SECRETS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 600 }, session }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: res.status === 401 ? 503 : 502, body: { error: res.status === 401 ? "BLOCKED_BY_OPENAI_KEY" : "openai_client_secret_failed", detail: detail.slice(0, 500) } };
  }
  const json = (await res.json()) as { value: string; expires_at: number; session?: { model?: string } };
  return {
    status: 200,
    body: { clientSecret: json.value, expiresAt: json.expires_at * 1000, model: json.session?.model ?? model, baseUrl: OPENAI_REALTIME_BASE_URL },
  };
}
