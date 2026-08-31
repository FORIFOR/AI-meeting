import type { BrokerEnv } from "../env.js";
import type { RouteResult } from "./openai.js";
import type { MeetingSessionRegistry, MeetingTokenRole } from "../meeting-session.js";
import type { MeetingStore } from "../recall/store.js";
import { RecallApiError, RecallClient } from "../recall/client.js";

/**
 * Recall.ai meeting bots (docs.recall.ai). Verified endpoints/fields (2026-08-30):
 *   POST {region}/api/v1/bot/           { meeting_url, bot_name, recording_config: { audio_mixed_raw: {}, transcript: { provider: { recallai_streaming: { mode, language_code } } },
 *                                         realtime_endpoints: [{ type: "websocket", url, events }], include_bot_in_recording: { audio } }, output_media: { camera: { kind: "webpage", config: { url } } }, metadata }
 *   GET  {region}/api/v1/bot/{id}/       → { id, status_changes: [{ code, sub_code, created_at }], meeting_url, ... }
 *   POST {region}/api/v1/bot/{id}/leave_call/
 *   POST {region}/api/v1/bot/{id}/output_audio/   { kind: "mp3", b64_data }   (short clips only; requires automatic_audio_output)
 *   POST {region}/api/v1/bot/{id}/output_media/   { camera: { kind: "webpage", config: { url } } }   (start/replace output media; DELETE stops it)
 * Realtime websocket payloads: audio_mixed_raw.data = base64 S16LE 16 kHz mono in 200 ms chunks; transcript.data/partial_data words[] + participant.
 * Status codes + sub_codes: docs.recall.ai/docs/bot-status-change-events, /docs/sub-codes (mapped in @rcai/meeting-core `mapRecallStatus`).
 * Regions: us-east-1 (= api.recall.ai), us-west-2, eu-central-1, ap-northeast-1.
 *
 * Round 3 Gate 5: every URL Recall or a browser receives carries a signed, short-lived, session-bound token
 * (see ../meeting-session.ts). The bot page URL never carries botId/character/persona in the clear.
 */
export const RECALL_EVENTS = [
  "audio_mixed_raw.data",
  "transcript.data",
  "transcript.partial_data",
  "participant_events.join",
  "participant_events.leave",
  "participant_events.update",
  "participant_events.speech_on",
  "participant_events.speech_off",
];

export function recallBase(env: BrokerEnv): string {
  const region = env.RECALL_REGION ?? "us-west-2";
  return `https://${region}.recall.ai/api/v1`;
}

export interface CreateBotBody {
  meetingUrl?: string;
  botName?: string;
  mode?: "output_media" | "relay";
  language?: string;
  botPageQuery?: Record<string, string>;
  /** Join even if a live session for the same meeting URL exists. */
  force?: boolean;
  /** ISO-8601 scheduled join time (calendar path); omitted means join now. */
  joinAt?: string;
  /** Calendar event this bot was scheduled from (calendar path). */
  calendarEventId?: string;
}

export interface RelayRegistry {
  register(token: string): void;
  bind(token: string, botId: string): void;
  clientUrl(botId: string): string;
  /** Drop every client of a bot (cleanup). */
  dropBot?(botId: string): void;
}

export interface MeetingDeps {
  relay: RelayRegistry;
  sessions: MeetingSessionRegistry;
  /** Durable meeting records; when present the scheduling intent is persisted before the bot exists. */
  store?: MeetingStore;
}

export function publicWsBase(publicUrl: string): string {
  return publicUrl.replace(/\/$/, "").replace(/^http/, "ws");
}

function botPageUrl(env: BrokerEnv, token: string): string {
  const base = env.RECALL_BOT_PAGE_URL!.replace(/\/$/, "");
  const q = new URLSearchParams({ rcai_bot: "1", token });
  return `${base}/?${q.toString()}`;
}

function outputMediaPayload(env: BrokerEnv, token: string): Record<string, unknown> {
  return { camera: { kind: "webpage", config: { url: botPageUrl(env, token) } } };
}

/**
 * Recall's streaming transcription only offers low latency for English; any other language_code is
 * rejected with `invalid_request_data`. Our own STT runs locally on the raw audio anyway, so the
 * Recall transcript is the record, not the conversation path — accuracy is the right trade here.
 */
/**
 * Output Media bot variant. Live2D draws through WebGL, and Recall's default `web` variant — like
 * `web_4_core` — has no WebGL at all (docs: Output Media → bot variants), so the canvas exists but paints
 * nothing and the tile stays black. `web_gpu` is the only variant that supports it. It costs more per hour,
 * hence the env override for deployments that use a non-WebGL renderer.
 */
export function botVariant(env: BrokerEnv): Record<string, string> {
  const v = env.RECALL_BOT_VARIANT ?? "web_gpu";
  return { zoom: v, google_meet: v, microsoft_teams: v };
}

export function streamingTranscript(language: string): Record<string, unknown> {
  const mode = language === "en" ? "prioritize_low_latency" : "prioritize_accuracy";
  return { recallai_streaming: { mode, language_code: language } };
}

export async function createRecallBot(env: BrokerEnv, body: CreateBotBody, fetchImpl: typeof fetch, deps: MeetingDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  if (!body.meetingUrl) return { status: 400, body: { error: "meetingUrl required" } };
  const mode = body.mode ?? "output_media";
  const publicUrl = env.RECALL_PUBLIC_URL;
  if (!publicUrl) return { status: 503, body: { error: "BLOCKED_BY_RECALL_PUBLIC_URL", detail: "Set RECALL_PUBLIC_URL to the public https URL of this broker (e.g. an ngrok/cloudflared tunnel) so Recall can reach the realtime relay websocket." } };
  if (mode === "output_media" && !env.RECALL_BOT_PAGE_URL) return { status: 503, body: { error: "BLOCKED_BY_RECALL_PUBLIC_URL", detail: "Set RECALL_BOT_PAGE_URL to the public URL of the web app (the bot streams that page as its camera/audio)." } };

  const { sessions, relay } = deps;
  const dup = sessions.findActiveByMeetingUrl(body.meetingUrl);
  if (dup && !body.force) return { status: 409, body: { error: "DUPLICATE_JOIN", sessionId: dup.id, botId: dup.botId, detail: "A live session for this meeting already exists; leave it or pass force:true." } };

  const session = sessions.create({ meetingUrl: body.meetingUrl, botName: body.botName ?? "Yui", mode, botPageQuery: body.botPageQuery });

  /**
   * Guide step 5: persist the scheduling intent BEFORE the Create Bot request, so an ambiguous
   * failure is reconciled rather than blindly retried. Any earlier unreconciled intent for the same
   * meeting URL is closed out first (its bot, if one exists, is found by the webhook metadata).
   */
  const store = deps.store;
  for (const stale of store?.unreconciled(body.meetingUrl) ?? []) store!.update(stale.id, { status: "create_failed" }, "reconciled_stale_intent");
  const record = store?.createIntent({
    meetingUrl: body.meetingUrl,
    botName: body.botName ?? "Yui",
    source: body.calendarEventId ? "calendar" : "url",
    calendarEventId: body.calendarEventId,
    scheduledFor: body.joinAt,
    sessionId: session.id,
  });

  const relayToken = sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
  relay.register(relayToken);
  const wsUrl = `${publicWsBase(publicUrl)}/api/meeting/recall/relay/${encodeURIComponent(relayToken)}/`;
  const language = (body.language ?? "ja").split("-")[0]!;
  const payload: Record<string, unknown> = {
    meeting_url: body.meetingUrl,
    bot_name: body.botName ?? "Yui",
    recording_config: {
      audio_mixed_raw: {},
      transcript: { provider: streamingTranscript(language) },
      realtime_endpoints: [{ type: "websocket", url: wsUrl, events: RECALL_EVENTS }],
      include_bot_in_recording: { audio: true },
    },
    metadata: { app: "rcai", mode, sessionId: session.id, ...(record ? { meetingRecordId: record.id } : {}) },
  };
  if (mode === "output_media") payload.variant = botVariant(env);
  if (body.joinAt) payload.join_at = body.joinAt;
  let pageUrl: string | undefined;
  let botPageTokenExpiresAt: number | undefined;
  if (mode === "output_media") {
    const pageToken = sessions.issue(session.id, "bot_page", { brokerPublicUrl: publicUrl });
    pageUrl = botPageUrl(env, pageToken);
    botPageTokenExpiresAt = Date.now() + 15 * 60_000;
    payload.output_media = outputMediaPayload(env, pageToken);
  }
  if (record) store!.update(record.id, { status: "creating" }, "creating");
  const client = new RecallClient({ apiKey: env.RECALL_API_KEY, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
  let bot: { id: string; status_changes?: { code: string }[] };
  try {
    bot = (await client.createBot(payload as unknown as Parameters<RecallClient["createBot"]>[0])) as { id: string; status_changes?: { code: string }[] };
  } catch (e) {
    sessions.end(session.id, "create_failed");
    if (record) store!.update(record.id, { status: "create_failed" }, "create_failed");
    const detail = e instanceof RecallApiError ? e.detail : String((e as Error).message).slice(0, 200);
    return { status: 502, body: { error: "recall_create_bot_failed", detail } };
  }
  sessions.bindBot(session.id, bot.id);
  if (record) store!.update(record.id, { botId: bot.id, status: "joining_call" }, "bot_created");
  relay.bind(relayToken, bot.id);
  const clientToken = sessions.issue(session.id, "client");
  const status = bot.status_changes?.[bot.status_changes.length - 1]?.code ?? "ready";
  return {
    status: 200,
    body: {
      botId: bot.id,
      sessionId: session.id,
      meetingRecordId: record?.id,
      status,
      mode,
      clientWsUrl: `${relay.clientUrl(bot.id)}?token=${encodeURIComponent(clientToken)}`,
      clientToken,
      botPageUrl: pageUrl,
      botPageTokenExpiresAt,
      region: env.RECALL_REGION ?? "us-west-2",
    },
  };
}

/** Bot page → broker: proves the page was loaded from a URL we issued; burns the nonce; returns the render config. */
export function activateBotPage(env: BrokerEnv, sessions: MeetingSessionRegistry, token: string | undefined, relay: RelayRegistry): RouteResult<Record<string, unknown>> {
  if (!token) return { status: 401, body: { error: "token required" } };
  const r = sessions.activateBotPage(token);
  if (!r.ok) return { status: 401, body: { error: "invalid_bot_page_token", detail: r.reason } };
  const s = r.session;
  if (!s.botId) return { status: 409, body: { error: "bot_not_bound_yet" } };
  const clientToken = sessions.issue(s.id, "client");
  return {
    status: 200,
    body: {
      sessionId: s.id,
      botId: s.botId,
      botName: s.botName,
      mode: s.mode,
      botPageQuery: s.botPageQuery,
      clientWsUrl: `${relay.clientUrl(s.botId)}?token=${encodeURIComponent(clientToken)}`,
      clientToken,
      activations: s.activations,
      // The page runs inside the bot, where loopback is blocked: it must be told the public origins.
      brokerUrl: env.RECALL_PUBLIC_URL ?? null,
      agentUrl: env.RECALL_AGENT_PUBLIC_URL ?? null,
    },
  };
}

/** Operator authentication: `Authorization: Bearer <client token>` whose session matches `sessionId`. */
export function authorizeOperator(sessions: MeetingSessionRegistry, sessionId: string, authHeader: string | undefined): RouteResult<{ ok: true }> {
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { status: 401, body: { error: "operator token required" } };
  const v = sessions.verify(token, { role: "client" });
  if (!v.ok) return { status: 401, body: { error: "invalid_operator_token", detail: v.reason } };
  if (v.session.id !== sessionId) return { status: 403, body: { error: "session_mismatch" } };
  return { status: 200, body: { ok: true } };
}

export function refreshMeetingToken(env: BrokerEnv, sessions: MeetingSessionRegistry, sessionId: string, authHeader: string | undefined, body: { role?: MeetingTokenRole }): RouteResult<Record<string, unknown>> {
  const auth = authorizeOperator(sessions, sessionId, authHeader);
  if (auth.status !== 200) return auth as RouteResult<Record<string, unknown>>;
  const role = body.role ?? "bot_page";
  if (role === "relay") return { status: 400, body: { error: "relay tokens cannot be refreshed (bound to the Recall endpoint)" } };
  const token = sessions.issue(sessionId, role, { brokerPublicUrl: env.RECALL_PUBLIC_URL });
  const out: Record<string, unknown> = { token, role };
  if (role === "bot_page" && env.RECALL_BOT_PAGE_URL) out.botPageUrl = botPageUrl(env, token);
  return { status: 200, body: out };
}

export function revokeMeetingSession(sessions: MeetingSessionRegistry, relay: RelayRegistry, sessionId: string, authHeader: string | undefined): RouteResult<Record<string, unknown>> {
  const auth = authorizeOperator(sessions, sessionId, authHeader);
  if (auth.status !== 200) return auth as RouteResult<Record<string, unknown>>;
  const s = sessions.get(sessionId)!;
  sessions.revoke(sessionId);
  if (s.botId) relay.dropBot?.(s.botId);
  return { status: 200, body: { ok: true, revoked: true } };
}

export function getMeetingSession(sessions: MeetingSessionRegistry, sessionId: string, authHeader: string | undefined): RouteResult<Record<string, unknown>> {
  const auth = authorizeOperator(sessions, sessionId, authHeader);
  if (auth.status !== 200) return auth as RouteResult<Record<string, unknown>>;
  const s = sessions.get(sessionId)!;
  return { status: 200, body: { sessionId: s.id, botId: s.botId, mode: s.mode, revoked: s.revoked, ended: s.ended, endReason: s.endReason, botPageActivatedAt: s.botPageActivatedAt, activations: s.activations, outputMediaRestarts: s.outputMediaRestarts, createdAt: s.createdAt } };
}

export async function getRecallBot(env: BrokerEnv, botId: string, fetchImpl: typeof fetch, deps?: MeetingDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  const res = await fetchImpl(`${recallBase(env)}/bot/${encodeURIComponent(botId)}/`, { headers: { Authorization: env.RECALL_API_KEY, accept: "application/json" } });
  if (!res.ok) return { status: 502, body: { error: "recall_get_bot_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  const bot = (await res.json()) as { id: string; meeting_url?: unknown; status_changes?: { code: string; sub_code?: string | null; created_at?: string }[] };
  const last = bot.status_changes?.[bot.status_changes.length - 1];
  const code = last?.code ?? "ready";
  if (deps && (code === "done" || code === "fatal" || code === "call_ended")) {
    let endedAny = false;
    for (const s of deps.sessions.allByBot(botId)) {
      if (!s.ended) {
        deps.sessions.end(s.id, `${code}${last?.sub_code ? `/${last.sub_code}` : ""}`);
        endedAny = true;
      }
    }
    if (endedAny) deps.relay.dropBot?.(botId);
  }
  const session = deps?.sessions.byBot(botId);
  return { status: 200, body: { botId: bot.id, code, subCode: last?.sub_code ?? null, updatedAt: last?.created_at, statusChanges: bot.status_changes ?? [], meetingUrl: bot.meeting_url, sessionId: session?.id, botPageActivatedAt: session?.botPageActivatedAt ?? null, outputMediaRestarts: session?.outputMediaRestarts ?? 0 } };
}

export async function leaveRecallBot(env: BrokerEnv, botId: string, fetchImpl: typeof fetch, deps?: MeetingDeps): Promise<RouteResult<{ ok: true }>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  const res = await fetchImpl(`${recallBase(env)}/bot/${encodeURIComponent(botId)}/leave_call/`, { method: "POST", headers: { Authorization: env.RECALL_API_KEY, accept: "application/json" } });
  if (deps) {
    for (const s of deps.sessions.allByBot(botId)) if (!s.ended) deps.sessions.end(s.id, "leave_call");
    deps.relay.dropBot?.(botId);
    const rec = deps.store?.byBot(botId);
    if (rec && rec.status !== "done") deps.store!.update(rec.id, { status: "left" }, "leave_call");
  }
  if (!res.ok) return { status: 502, body: { error: "recall_leave_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  return { status: 200, body: { ok: true } };
}

/** Restart the Output Media webpage with a fresh single-use bot-page token (output_media_failed recovery). */
export async function restartOutputMedia(env: BrokerEnv, botId: string, fetchImpl: typeof fetch, deps: MeetingDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  if (!env.RECALL_BOT_PAGE_URL || !env.RECALL_PUBLIC_URL) return { status: 503, body: { error: "BLOCKED_BY_RECALL_PUBLIC_URL" } };
  const s = deps.sessions.byBot(botId);
  if (!s || s.ended || s.revoked) return { status: 404, body: { error: "unknown_or_ended_session" } };
  const pageToken = deps.sessions.issue(s.id, "bot_page", { brokerPublicUrl: env.RECALL_PUBLIC_URL });
  const headers = { Authorization: env.RECALL_API_KEY, "Content-Type": "application/json", accept: "application/json" };
  await fetchImpl(`${recallBase(env)}/bot/${encodeURIComponent(botId)}/output_media/`, { method: "DELETE", headers }).catch(() => null);
  const res = await fetchImpl(`${recallBase(env)}/bot/${encodeURIComponent(botId)}/output_media/`, { method: "POST", headers, body: JSON.stringify(outputMediaPayload(env, pageToken)) });
  if (!res.ok) return { status: 502, body: { error: "recall_output_media_restart_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  s.outputMediaRestarts++;
  s.botPageActivatedAt = null;
  return { status: 200, body: { ok: true, restarts: s.outputMediaRestarts } };
}

export async function outputRecallAudio(env: BrokerEnv, botId: string, body: { kind?: string; b64_data?: string }, fetchImpl: typeof fetch): Promise<RouteResult<{ ok: true }>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  if (body.kind !== "mp3" || !body.b64_data) return { status: 400, body: { error: "kind must be mp3 with b64_data" } };
  const res = await fetchImpl(`${recallBase(env)}/bot/${encodeURIComponent(botId)}/output_audio/`, {
    method: "POST",
    headers: { Authorization: env.RECALL_API_KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ kind: "mp3", b64_data: body.b64_data }),
  });
  if (!res.ok) return { status: 502, body: { error: "recall_output_audio_failed", detail: (await res.text().catch(() => "")).slice(0, 300) } };
  return { status: 200, body: { ok: true } };
}
