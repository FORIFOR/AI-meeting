import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

export const GEMINI_AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

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
  // The operator's pin wins: the client asks for a model, the broker decides which one it is allowed to
  // have. Without this a deployment could not move models without shipping a new client build.
  const model = env.GEMINI_LIVE_MODEL ?? req.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  const expireTime = new Date(now() + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(now() + 2 * 60_000).toISOString();
  const res = await fetchImpl(GEMINI_AUTH_TOKENS_URL, {
    method: "POST",
    headers: { "x-goog-api-key": env.GEMINI_API_KEY, "Content-Type": "application/json" },
        /**
     * No `bidiGenerateContentSetup` constraint. Google treats it as THE session setup and ignores the
     * client's, which silently dropped systemInstruction, voice and inputAudioTranscription — the model
     * answered but the user's own speech was never transcribed. `uses: 1` and the two-minute
     * new-session window stay as the containment.
     */
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { status: res.status === 400 || res.status === 403 ? 503 : 502, body: { error: res.status === 403 ? "BLOCKED_BY_GEMINI_KEY" : "gemini_auth_token_failed", detail: detail.slice(0, 500) } };
  }
  const json = (await res.json()) as { name: string; expireTime?: string };
  return { status: 200, body: { token: json.name, expiresAt: Date.parse(json.expireTime ?? expireTime), model } };
}
