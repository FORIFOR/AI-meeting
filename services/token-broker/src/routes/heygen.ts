import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

/**
 * HeyGen LiveAvatar API (current product; docs.liveavatar.com — the legacy
 * docs.heygen.com "streaming" pages now 404):
 *   POST https://api.liveavatar.com/v1/sessions/token   (X-API-KEY)  { mode:"LITE", avatar_id } -> data.{session_id, session_token}
 *   POST https://api.liveavatar.com/v1/sessions/start   (Bearer session_token)               -> data.{session_id, livekit_url, livekit_client_token, ws_url?}
 *   POST https://api.liveavatar.com/v1/sessions/stop    (Bearer session_token)  { session_id, reason }
 * LITE mode is required so our own assistant audio can drive the avatar over ws_url (agent.speak PCM16 24 kHz).
 * UNVERIFIED against a live account (BLOCKED_BY_HEYGEN_KEY).
 */
export const LIVEAVATAR_BASE = "https://api.liveavatar.com/v1";

export interface HeyGenSessionResponse {
  sessionId: string;
  livekitUrl: string;
  livekitClientToken: string;
  wsUrl?: string;
  sessionToken: string;
  mode: "LITE" | "FULL";
  raw: Record<string, unknown>;
}

export interface HeyGenSessionRequest {
  avatarId?: string;
  voiceId?: string;
  mode?: "LITE" | "FULL";
}

export async function createHeyGenSession(env: BrokerEnv, req: HeyGenSessionRequest, fetchImpl: typeof fetch): Promise<RouteResult<HeyGenSessionResponse>> {
  if (!env.HEYGEN_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_HEYGEN_KEY" } };
  const mode = req.mode ?? "LITE";
  const tokenBody: Record<string, unknown> = { mode, avatar_id: req.avatarId ?? env.HEYGEN_AVATAR_ID };
  const voice = req.voiceId ?? env.HEYGEN_VOICE_ID;
  if (voice && mode === "FULL") tokenBody.voice_id = voice;
  const tokenRes = await fetchImpl(`${LIVEAVATAR_BASE}/sessions/token`, {
    method: "POST",
    headers: { "X-API-KEY": env.HEYGEN_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(tokenBody),
  });
  if (!tokenRes.ok) return { status: 502, body: { error: "heygen_session_token_failed", detail: (await tokenRes.text().catch(() => "")).slice(0, 300) } };
  const tokenJson = (await tokenRes.json()) as { data?: { session_id?: string; session_token?: string } };
  const sessionToken = tokenJson.data?.session_token;
  const sessionId = tokenJson.data?.session_id;
  if (!sessionToken || !sessionId) return { status: 502, body: { error: "heygen_session_token_failed" } };

  const startRes = await fetchImpl(`${LIVEAVATAR_BASE}/sessions/start`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!startRes.ok) return { status: 502, body: { error: "heygen_start_failed", detail: (await startRes.text().catch(() => "")).slice(0, 300) } };
  const data = ((await startRes.json()) as { data?: Record<string, unknown> }).data ?? {};
  const livekitUrl = String(data.livekit_url ?? "");
  const livekitClientToken = String(data.livekit_client_token ?? "");
  if (!livekitUrl || !livekitClientToken) return { status: 502, body: { error: "heygen_start_failed", detail: "missing livekit_url / livekit_client_token" } };
  return {
    status: 200,
    body: {
      sessionId: String(data.session_id ?? sessionId),
      livekitUrl,
      livekitClientToken,
      wsUrl: typeof data.ws_url === "string" ? data.ws_url : undefined,
      sessionToken,
      mode,
      raw: data,
    },
  };
}

export async function stopHeyGenSession(env: BrokerEnv, req: { sessionId?: string; sessionToken?: string; reason?: string }, fetchImpl: typeof fetch): Promise<RouteResult<{ ok: true }>> {
  if (!env.HEYGEN_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_HEYGEN_KEY" } };
  if (!req.sessionId || !req.sessionToken) return { status: 400, body: { error: "sessionId and sessionToken required" } };
  const res = await fetchImpl(`${LIVEAVATAR_BASE}/sessions/stop`, {
    method: "POST",
    headers: { Authorization: `Bearer ${req.sessionToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: req.sessionId, reason: req.reason ?? "client_stop" }),
  });
  if (!res.ok) return { status: 502, body: { error: "heygen_stop_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  return { status: 200, body: { ok: true } };
}
