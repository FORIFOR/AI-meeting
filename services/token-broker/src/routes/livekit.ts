import { AccessToken } from "livekit-server-sdk";
import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

export async function createLiveKitToken(env: BrokerEnv, req: { room?: string; identity?: string }): Promise<RouteResult<{ url: string; token: string }>> {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return { status: 503, body: { error: "BLOCKED_BY_LIVEKIT_KEY" } };
  if (!req.room || !req.identity) return { status: 400, body: { error: "room and identity required" } };
  const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, { identity: req.identity, ttl: "1h" });
  at.addGrant({ roomJoin: true, room: req.room, canPublish: true, canSubscribe: true });
  return { status: 200, body: { url: env.LIVEKIT_URL, token: await at.toJwt() } };
}
