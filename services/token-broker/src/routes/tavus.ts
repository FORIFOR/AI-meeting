import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";

export const TAVUS_CONVERSATIONS_URL = "https://tavusapi.com/v2/conversations";

export interface TavusConversationResponse {
  conversationId: string;
  conversationUrl: string;
  status?: string;
}

/**
 * POST https://tavusapi.com/v2/conversations (x-api-key)
 * (verified 2026-08-30: docs.tavus.io/api-reference/conversations/create-conversation —
 *  current spec names `face_id`/`pal_id`; legacy `replica_id`/`persona_id` are forwarded too.)
 */
export async function createTavusConversation(
  env: BrokerEnv,
  req: { personaId?: string; replicaId?: string; palId?: string; faceId?: string; conversationName?: string; context?: string; greeting?: string },
  fetchImpl: typeof fetch,
): Promise<RouteResult<TavusConversationResponse>> {
  if (!env.TAVUS_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_TAVUS_KEY" } };
  const body: Record<string, unknown> = {};
  const replica = req.replicaId ?? env.TAVUS_REPLICA_ID;
  const persona = req.personaId ?? env.TAVUS_PERSONA_ID;
  if (req.faceId ?? replica) body.face_id = req.faceId ?? replica;
  if (req.palId ?? persona) body.pal_id = req.palId ?? persona;
  if (replica) body.replica_id = replica;
  if (persona) body.persona_id = persona;
  if (req.conversationName) body.conversation_name = req.conversationName;
  if (req.context) body.conversational_context = req.context;
  if (req.greeting) body.custom_greeting = req.greeting;
  const res = await fetchImpl(TAVUS_CONVERSATIONS_URL, { method: "POST", headers: { "x-api-key": env.TAVUS_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) return { status: res.status === 401 ? 503 : 502, body: { error: res.status === 401 ? "BLOCKED_BY_TAVUS_KEY" : "tavus_conversation_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  const json = (await res.json()) as { conversation_id: string; conversation_url: string; status?: string };
  return { status: 200, body: { conversationId: json.conversation_id, conversationUrl: json.conversation_url, status: json.status } };
}
