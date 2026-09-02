import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

export const GEMINI_AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
export const DEFAULT_GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";

/**
 * The model a session may ask for when the operator has not pinned one.
 *
 * Two live families, and the choice is a real trade-off rather than a version number: the flash-live
 * models answer faster, the native-audio ones are the only ones that take affective dialog and
 * proactive audio. A caller that wants the character to react to how something was said has to be
 * able to ask for the second, and an allowlist keeps that from becoming "any string reaches Google".
 *
 * These ids come from the account's own `models.list` filtered to `bidiGenerateContent`, not from
 * documentation: an earlier version of this list contained two names that read plausibly and did not
 * exist, and a wrong name here fails as `1008 ... not supported for bidiGenerateContent` at the first
 * frame, long after the token was minted and everything looked fine.
 */
export const GEMINI_LIVE_MODELS = [
  "gemini-3.1-flash-live-preview",
  "gemini-2.5-flash-native-audio-latest",
  "gemini-2.5-flash-native-audio-preview-12-2025",
  "gemini-2.5-flash-native-audio-preview-09-2025",
] as const;

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
  const requested = req.model && (GEMINI_LIVE_MODELS as readonly string[]).includes(req.model) ? req.model : undefined;
  const model = env.GEMINI_LIVE_MODEL ?? requested ?? DEFAULT_GEMINI_LIVE_MODEL;
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
