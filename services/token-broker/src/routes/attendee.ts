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
  /** 8000 | 16000 | 24000. Defaults to 16000, which is what the agent accepts. */
  sampleRate?: number;
  botPageQuery?: Record<string, string>;
}

export interface AttendeeDeps {
  relay: RelayRegistry & { clientUrl(botId: string): string };
  sessions: MeetingSessionRegistry;
  /** Durable record, so an Attendee meeting has a lifecycle and a result screen like a Recall one. */
  store?: { createIntent(o: { meetingUrl: string; botName?: string; source?: string }): { id: string }; update(id: string, patch: Record<string, unknown>, event?: string): unknown };
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
  /**
   * 16 kHz, because that is the rate the local agent's binary input is defined at — raw PCM16 mono, no
   * header. Sending 24 kHz "because the TTS produces it" stretched every utterance by half and the
   * recogniser returned confident nonsense in the wrong language. The character's own voice leaves
   * through the page, so its rate is a separate question.
   */
  const sampleRate = body.sampleRate ?? 16000;
  const session = deps.sessions.create({ meetingUrl: body.meetingUrl, botName, mode: "relay", botPageQuery: { ...(body.botPageQuery ?? {}), provider: "attendee" } });
  const audioToken = deps.sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
  deps.relay.register(audioToken);

  const pageToken = env.RECALL_BOT_PAGE_URL ? deps.sessions.issue(session.id, "bot_page", { brokerPublicUrl: publicUrl }) : null;
  const botPageUrl = pageToken
    ? `${env.RECALL_BOT_PAGE_URL!.replace(/\/$/, "")}/?${new URLSearchParams({ rcai_bot: "1", token: pageToken })}`
    : undefined;

  const record = deps.store?.createIntent({ meetingUrl: body.meetingUrl, botName, source: "attendee" }) ?? null;

  const payload: Record<string, unknown> = {
    meeting_url: body.meetingUrl,
    bot_name: botName,
    websocket_settings: {
      audio: { url: `${publicWsBase(publicUrl)}/api/meeting/attendee/audio/${encodeURIComponent(audioToken)}`, sample_rate: sampleRate },
    },
    /**
     * State comes from here and nowhere else. Without it an Attendee bot that fails to join is invisible:
     * no lifecycle, no error, no way to tell "waiting to be admitted" from "was refused".
     */
    webhooks: [{ url: `${publicUrl.replace(/\/$/, "")}/api/attendee/webhooks`, triggers: ["bot.state_change"] }],
  };
  /**
   * The avatar page as the bot's camera. Taken from Attendee's voice-agent guidance rather than a field
   * we have exercised — the audio path above is verified, this is not. It is sent only when a deployment
   * asks for it, so an unknown field cannot break the join.
   */
  /**
   * The avatar page as the bot's camera. Attendee runs it in its own browser and streams the page's audio
   * and video into the meeting — the same shape as Recall's Output Media, so the character is seen and
   * heard from one place. Meeting audio reaches that page over our relay, not getUserMedia, because the
   * page is a voice agent rather than the bot itself.
   */
  if (botPageUrl && env.ATTENDEE_VOICE_AGENT !== "off") {
    /**
     * `reserve_resources` is the switch, not `url`. Attendee only launches the webpage streamer when it
     * is true (`should_launch_webpage_streamer`), and without it the URL is simply stored: the bot joins,
     * records, and never renders or speaks — which is exactly what a first live run looked like, with no
     * error anywhere to say so.
     */
    payload.voice_agent_settings = { url: botPageUrl, reserve_resources: true };
  }

  const res = await fetchImpl(`${ATTENDEE_BASE}/api/v1/bots`, {
    method: "POST",
    headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    deps.sessions.end(session.id, "create_failed");
    if (record) deps.store!.update(record.id, { status: "create_failed" }, "create_failed");
    return { status: res.status === 402 ? 402 : 502, body: { error: res.status === 402 ? "BLOCKED_BY_ATTENDEE_CREDIT" : "attendee_create_bot_failed", detail: text.slice(0, 300) } };
  }
  const bot = JSON.parse(text) as { id?: string; state?: string };
  const botId = bot.id ?? "";
  deps.sessions.bindBot(session.id, botId);
  if (record) deps.store!.update(record.id, { botId, status: "joining_call" }, "bot_created");
  deps.relay.bind(audioToken, botId);
  const clientToken = deps.sessions.issue(session.id, "client");
  /**
   * The avatar page runs on our side, not inside the bot: only audio crosses to Attendee, on the socket
   * that is actually verified. Rendering the page as the bot's camera is the unproven part
   * (`voice_agent_settings`), so the character can be heard long before it can be seen.
   */
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
      meetingRecordId: record?.id,
    },
  };
}

/** Attendee's own message shapes, so callers do not have to guess them. */
export const ATTENDEE_INBOUND_TRIGGER = "realtime_audio.mixed";
export const ATTENDEE_OUTBOUND_TRIGGER = "realtime_audio.bot_output";

/**
 * Remove the bot from the meeting.
 *
 * A bot that is not told to leave keeps running — and waiting-room and in-call time are both billed — so
 * a harness or a UI that can start one must be able to stop it. The first version of this file could
 * only create; the test harness called a leave route that did not exist and nothing said so, because a
 * 404 on cleanup looks exactly like success when nobody checks.
 */
export async function leaveAttendeeBot(env: BrokerEnv, botId: string, fetchImpl: typeof fetch, deps: AttendeeDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.ATTENDEE_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_ATTENDEE_KEY" } };
  const res = await fetchImpl(`${ATTENDEE_BASE}/api/v1/bots/${encodeURIComponent(botId)}/leave`, {
    method: "POST",
    headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, "content-type": "application/json" },
  });
  const detail = await res.text();
  const session = deps.sessions.byBot(botId);
  if (session) deps.sessions.end(session.id, "left");
  deps.relay.dropBot?.(botId);
  if (!res.ok) return { status: 502, body: { error: "attendee_leave_failed", detail: detail.slice(0, 300) } };
  return { status: 200, body: { ok: true } };
}
