import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

const SESSION_TOKEN_URL = "https://api.anam.ai/v1/auth/session-token";
export const ANAM_SESSION_TIMEOUT_MS = 8_000;
const CHARACTER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const AVATAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVATAR_MODEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type AnamConfig = { avatarModel: string; avatarIds: Record<string, string> };

/** Fail closed: a partially invalid mapping must not advertise the wrong character identity. */
function readConfig(env: BrokerEnv): AnamConfig | null {
  const avatarModel = env.ANAM_AVATAR_MODEL ?? "cara-4";
  if (!AVATAR_MODEL.test(avatarModel) || !env.ANAM_AVATAR_IDS || env.ANAM_AVATAR_IDS.length > 64_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.ANAM_AVATAR_IDS);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  const avatarIds: Record<string, string> = Object.create(null);
  for (const [characterId, avatarId] of entries) {
    if (!CHARACTER_ID.test(characterId) || typeof avatarId !== "string" || !AVATAR_UUID.test(avatarId)) return null;
    avatarIds[characterId] = avatarId;
  }
  return { avatarModel, avatarIds };
}

/** Public availability never includes account keys, avatar UUIDs, or vendor configuration. */
export function anamAvailability(env: BrokerEnv): { configured: boolean; characterIds: string[] } {
  const config = env.ANAM_API_KEY?.trim() ? readConfig(env) : null;
  return { configured: Boolean(config), characterIds: config ? Object.keys(config.avatarIds).sort() : [] };
}

/** Audio passthrough renders our speaker PCM; Anam must not start its own conversational pipeline. */
export async function createAnamSession(
  env: BrokerEnv,
  req: unknown,
  fetchImpl: typeof fetch,
): Promise<RouteResult<{ sessionToken: string }>> {
  if (!req || typeof req !== "object" || Array.isArray(req)) return { status: 400, body: { error: "invalid_anam_session" } };
  const body = req as Record<string, unknown>;
  if (body.privacyMode === "strict_local") return { status: 403, body: { error: "BLOCKED_BY_STRICT_LOCAL" } };
  if (
    typeof body.characterId !== "string" || !CHARACTER_ID.test(body.characterId) ||
    (body.privacyMode !== undefined && body.privacyMode !== "default") ||
    Object.keys(body).some((key) => key !== "characterId" && key !== "privacyMode")
  ) return { status: 400, body: { error: "invalid_anam_session" } };
  if (!env.ANAM_API_KEY?.trim()) return { status: 503, body: { error: "BLOCKED_BY_ANAM_KEY" } };
  const config = readConfig(env);
  if (!config) return { status: 503, body: { error: "BLOCKED_BY_ANAM_AVATAR_CONFIG" } };
  const avatarId = config.avatarIds[body.characterId];
  if (!avatarId) return { status: 503, body: { error: "BLOCKED_BY_ANAM_CHARACTER" } };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("anam_session_timeout"));
    }, ANAM_SESSION_TIMEOUT_MS);
  });
  try {
    // One attempt, including body parsing, fits within the same deadline. Never retry token creation.
    return await Promise.race([
      (async (): Promise<RouteResult<{ sessionToken: string }>> => {
        const response = await fetchImpl(SESSION_TOKEN_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.ANAM_API_KEY}`, "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            personaConfig: { avatarId, avatarModel: config.avatarModel, enableAudioPassthrough: true },
            sessionOptions: { sessionReplay: { enableSessionReplay: false } },
          }),
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return response.status === 401 || response.status === 403
            ? { status: 503, body: { error: "BLOCKED_BY_ANAM_KEY" } }
            : { status: 502, body: { error: "anam_session_failed" } };
        }
        const result: unknown = await response.json();
        const token = result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>).sessionToken : undefined;
        if (typeof token !== "string" || !token.trim() || token === env.ANAM_API_KEY) {
          return { status: 502, body: { error: "invalid_anam_session_token" } };
        }
        return { status: 200, body: { sessionToken: token } };
      })(),
      timeout,
    ]);
  } catch {
    return controller.signal.aborted
      ? { status: 504, body: { error: "anam_session_timeout" } }
      : { status: 502, body: { error: "anam_session_failed" } };
  } finally {
    clearTimeout(timer);
  }
}
