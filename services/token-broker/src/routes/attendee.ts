import type { BrokerEnv } from "../env.js";
import type { MeetingSessionRegistry } from "../meeting-session.js";
import { publicWsBase, type RelayRegistry } from "./meeting.js";

/**
 * Attendee (app.attendee.dev) — a second meeting provider behind the same connector contract.
 *
 * Verified against the API and the vendor's own example:
 *   POST https://app.attendee.dev/api/v1/bots
 *   Authorization: Token <key>
 *   { meeting_url, bot_name, websocket_settings: { audio: { url, sample_rate } } }
 *
 * The audio socket is bidirectional — Attendee sends `realtime_audio.mixed` and takes
 * `realtime_audio.bot_output` back on the same connection — which is why the relay had to learn to talk
 * back. `sample_rate` may be 8000, 16000 or 24000; 24000 is what our TTS already produces, so the
 * character's voice needs no resampling on the way out.
 *
 * Why this exists next to Recall: Recall's only WebGL variant is `web_gpu` at $1.50/h, and Live2D needs
 * WebGL. If Attendee runs the same avatar page without a GPU surcharge, the bot cost falls by roughly
 * two thirds. Which one is better is a measurement, not an opinion — hence the same gates run on both.
 */
const ATTENDEE_BASE = "https://app.attendee.dev";

export interface AttendeeJoinBody {
  meetingUrl: string;
  botName?: string;
  /** 8000 | 16000 | 24000. Defaults to 24000 to match the local TTS. */
  sampleRate?: number;
  botPageQuery?: Record<string, string>;
}

export interface AttendeeDeps {
  relay: RelayRegistry & { clientUrl(botId: string): string };
  sessions: MeetingSessionRegistry;
}

export interface RouteResult<T> {
  status: number;
  body: T;
}

export async function createAttendeeBot(
  env: BrokerEnv,
  body: AttendeeJoinBody,
  fetchImpl: typeof fetch,
  deps: AttendeeDeps,
): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.ATTENDEE_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_ATTENDEE_KEY" } };
  const publicUrl = env.RECALL_PUBLIC_URL;
  if (!publicUrl) return { status: 503, body: { error: "BLOCKED_BY_PUBLIC_URL", detail: "Attendee needs a public wss endpoint to stream audio to" } };
  if (!body.meetingUrl) return { status: 400, body: { error: "meetingUrl required" } };

  const botName = body.botName ?? env.RECALL_BOT_NAME ?? "Yui";
  const sampleRate = body.sampleRate ?? 24000;
  const session = deps.sessions.create({ meetingUrl: body.meetingUrl, botName, mode: "relay", botPageQuery: { ...(body.botPageQuery ?? {}), provider: "attendee" } });
  const audioToken = deps.sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
  deps.relay.register(audioToken);

  const payload: Record<string, unknown> = {
    meeting_url: body.meetingUrl,
    bot_name: botName,
    websocket_settings: {
      audio: { url: `${publicWsBase(publicUrl)}/api/meeting/attendee/audio/${encodeURIComponent(audioToken)}`, sample_rate: sampleRate },
    },
  };
  /**
   * The avatar page as the bot's camera. Taken from Attendee's voice-agent guidance rather than a field
   * we have exercised — the audio path above is verified, this is not. It is sent only when a deployment
   * asks for it, so an unknown field cannot break the join.
   */
  if (env.ATTENDEE_VOICE_AGENT_PAGE) payload.voice_agent_settings = { url: env.ATTENDEE_VOICE_AGENT_PAGE };

  const res = await fetchImpl(`${ATTENDEE_BASE}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    deps.sessions.end(session.id, "create_failed");
    return { status: res.status === 402 ? 402 : 502, body: { error: res.status === 402 ? "BLOCKED_BY_ATTENDEE_CREDIT" : "attendee_create_bot_failed", detail: text.slice(0, 300) } };
  }
  const bot = JSON.parse(text) as { id?: string; state?: string };
  const botId = bot.id ?? "";
  deps.sessions.bindBot(session.id, botId);
  deps.relay.bind(audioToken, botId);
  const clientToken = deps.sessions.issue(session.id, "client");
  /**
   * The avatar page runs on our side, not inside the bot: only audio crosses to Attendee, on the socket
   * that is actually verified. Rendering the page as the bot's camera is the unproven part
   * (`voice_agent_settings`), so the character can be heard long before it can be seen.
   */
  const pageToken = env.RECALL_BOT_PAGE_URL ? deps.sessions.issue(session.id, "bot_page", { brokerPublicUrl: publicUrl }) : null;
  const botPageUrl = pageToken
    ? `${env.RECALL_BOT_PAGE_URL!.replace(/\/$/, "")}/?${new URLSearchParams({ rcai_bot: "1", token: pageToken })}`
    : undefined;
  return {
    status: 200,
    body: {
      provider: "attendee",
      botId,
      sessionId: session.id,
      state: bot.state ?? "joining",
      sampleRate,
      clientWsUrl: `${deps.relay.clientUrl(botId)}?token=${encodeURIComponent(clientToken)}`,
      clientToken,
      botPageUrl,
    },
  };
}

/** Attendee's own message shapes, so callers do not have to guess them. */
export const ATTENDEE_INBOUND_TRIGGER = "realtime_audio.mixed";
export const ATTENDEE_OUTBOUND_TRIGGER = "realtime_audio.bot_output";
