import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

export const GEMINI_AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";

export interface GeminiTokenResponse {
  token: string;
  expiresAt: number;
  model: string;
}

/**
 * POST https://generativelanguage.googleapis.com/v1beta/auth_tokens  (x-goog-api-key)
 * (verified 2026-08-30: ai.google.dev/gemini-api/docs/ephemeral-tokens — response.name is the token;
 *  connect with `?access_token=` or `Authorization: Token <name>`)
 */
export async function createGeminiEphemeralToken(env: BrokerEnv, req: { model?: string }, fetchImpl: typeof fetch, now: () => number = Date.now): Promise<RouteResult<GeminiTokenResponse>> {
  if (!env.GEMINI_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_GEMINI_KEY" } };
  const model = req.model ?? env.GEMINI_LIVE_MODEL ?? DEFAULT_GEMINI_LIVE_MODEL;
  const expireTime = new Date(now() + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now() + 2 * 60_000).toISOString();
  const res = await fetchImpl(GEMINI_AUTH_TOKENS_URL, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime, liveConnectConstraints: { model: `models/${model}` } }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: res.status === 400 || res.status === 403 ? 503 : 502, body: { error: res.status === 403 ? "BLOCKED_BY_GEMINI_KEY" : "gemini_auth_token_failed", detail: detail.slice(0, 500) } };
  }
  const json = (await res.json()) as { name: string; expireTime?: string };
  return { status: 200, body: { token: json.name, expiresAt: Date.parse(json.expireTime ?? expireTime), model } };
}
