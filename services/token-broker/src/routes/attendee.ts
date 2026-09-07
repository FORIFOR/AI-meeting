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
/**
 * Overridable so the whole path can be exercised without a live meeting: a local stand-in speaks the
 * same API and the same websocket protocol, and everything between the broker and the bot page is the
 * real thing. Attendee's own example reads the same variable.
 */
const attendeeBase = (env: BrokerEnv): string => env.ATTENDEE_API_BASE_URL ?? "https://app.attendee.dev";

export interface AttendeeJoinBody {
  meetingUrl: string;
  botName?: string;
  /** 8000 | 16000 | 24000. Defaults to 16000, which is what the agent accepts. */
  sampleRate?: number;
  botPageQuery?: Record<string, string>;
  /**
   * `character` (default) carries the avatar page as its camera. `listener` is a second bot in the same
   * meeting with no page: it records what the room sees and hears — including the character, which the
   * character's own bot never captures — and its relay socket lets a harness hear and speak into the
   * room. The automated gate is a listener plus a character.
   */
  role?: "character" | "listener";
  /** Vendor recording: what it records and at which resolution. Unset keeps Attendee's default. */
  /** `format: "mp3"` keeps the audio and drops the bot's own screen capture — the one thing a self-hosted, emulated bot host cannot afford twice. */
  recording?: { view?: "speaker_view" | "gallery_view" | "speaker_view_no_sidebar"; resolution?: "1080p" | "720p"; format?: "mp4" | "mp3" };
  /**
   * Who writes the vendor transcript. `deepgram` (default) needs a Deepgram credential on the Attendee
   * project — a self-hosted stack without one records silently nothing (Gate #8 runs 44–47: 0/0
   * utterances). `closed_captions` has the bot switch on the platform's own captions and read them:
   * no key, and for a listener judging whether the room could hear the character, the platform's
   * recogniser is the better witness anyway.
   */
  transcription?: "deepgram" | "closed_captions";
  /**
   * When the vendor may take the bot out of the room on its own. Seconds; unset fields keep the broker's
   * defaults below, which in turn override the vendor's.
   */
  automaticLeave?: { silenceTimeoutSeconds?: number; silenceActivateAfterSeconds?: number; maxUptimeSeconds?: number };
}

/**
 * Attendee's own defaults leave after 600 s without a non-zero audio frame once the bot has been in the
 * room for 1200 s. A recorder can afford that; a participant cannot. A meeting goes quiet for ten
 * minutes while people read a document or wait for the last attendee, and a character that slips out
 * during the pause is gone for the question that ends it (Gate #8 run 83: Yui left with
 * `auto_leave_silence` exactly 1800 s after joining, seconds before the next pass began). An hour of
 * silence is the point at which "nobody is talking" more likely means "nobody is here"; the vendor's
 * only-participant timeout still covers the room that actually emptied.
 */
export const ATTENDEE_SILENCE_TIMEOUT_SECONDS = 3600;

export interface AttendeeDeps {
  relay: RelayRegistry & { clientUrl(botId: string): string };
  sessions: MeetingSessionRegistry;
  /** Durable record, so an Attendee meeting has a lifecycle and a result screen like a Recall one. */
  store?: { createIntent(o: { meetingUrl: string; botName?: string; source?: string }): { id: string }; update(id: string, patch: Record<string, unknown>, event?: string): unknown };
}

import { modeAvailable, platformAvailable, releaseChannel } from "@rcai/conversation-core";

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
  if (body.botPageQuery?.persona === "companion_ja" && !modeAvailable("companion", releaseChannel(env.RCAI_RELEASE_CHANNEL))) return { status: 403, body: { error: "MODE_NOT_RELEASED" } };
  if (body.meetingUrl && !platformAvailable(body.meetingUrl, releaseChannel(env.RCAI_RELEASE_CHANNEL))) return { status: 403, body: { error: "PLATFORM_NOT_RELEASED", detail: "このプラットフォームは現在の公開範囲では利用できません。" } };
  if (!env.ATTENDEE_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_ATTENDEE_KEY" } };
  const publicUrl = env.RECALL_PUBLIC_URL;
  if (!publicUrl) return { status: 503, body: { error: "BLOCKED_BY_PUBLIC_URL", detail: "Attendee needs a public wss endpoint to stream audio to" } };
  if (!body.meetingUrl) return { status: 400, body: { error: "meetingUrl required" } };

  const botName = body.botName ?? env.RECALL_BOT_NAME ?? "Yui";
  const role = body.role ?? "character";
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

  const pageToken = env.RECALL_BOT_PAGE_URL && role === "character" ? deps.sessions.issue(session.id, "bot_page", { brokerPublicUrl: publicUrl }) : null;
  const botPageUrl = pageToken
    ? `${env.RECALL_BOT_PAGE_URL!.replace(/\/$/, "")}/?${new URLSearchParams({ rcai_bot: "1", token: pageToken })}`
    : undefined;

  const record = deps.store?.createIntent({ meetingUrl: body.meetingUrl, botName, source: "attendee" }) ?? null;

  /**
   * Per-speaker streams, on their own sockets because Attendee wants one URL per stream type.
   *
   *   mixed audio         what the character hears — one stream, everyone in it
   *   per-participant     who is speaking, and their webcam at 2 fps
   *
   * The mixed stream stays the character's ears: splitting the AI's input per speaker is a separate
   * change. These carry identity and visual cues, which is what a conversation needs to know whose
   * turn it is and whether the person it is talking to just nodded.
   */
  const participantAudioToken = deps.sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
  const participantVideoToken = deps.sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
  deps.relay.register(participantAudioToken);
  deps.relay.register(participantVideoToken);

  const wsBase = publicWsBase(publicUrl);
  const payload: Record<string, unknown> = {
    meeting_url: body.meetingUrl,
    bot_name: botName,
    websocket_settings: {
      audio: { url: `${wsBase}/api/meeting/attendee/audio/${encodeURIComponent(audioToken)}`, sample_rate: sampleRate },
      /**
       * Only the character has a use for who is speaking and what they look like. A listener judges
       * the room by its mixed audio and its recording, and each extra stream is more work in the bot
       * host's browser (a track processor per speaker, a JPEG per participant twice a second) —
       * work that, on a self-hosted host already short of CPU, showed up as holes in the character's
       * hearing (Gate #8 run 70).
       */
      ...(role === "character"
        ? {
            per_participant_audio: { url: `${wsBase}/api/meeting/attendee/participant-audio/${encodeURIComponent(participantAudioToken)}`, sample_rate: sampleRate },
            /**
             * 360p is 2 fps at JPEG quality 70 (Attendee picks the framerate from the resolution), which is
             * what a nod detector needs and far less than a face model can use. Screenshare is off: it is a
             * different problem and a much larger frame.
             */
            per_participant_video: { url: `${wsBase}/api/meeting/attendee/participant-video/${encodeURIComponent(participantVideoToken)}`, webcam_resolution: "360p", screenshare_resolution: "none" },
          }
        : {}),
    },
    /**
     * State comes from here and nowhere else. Without it an Attendee bot that fails to join is invisible:
     * no lifecycle, no error, no way to tell "waiting to be admitted" from "was refused".
     */
    webhooks: [{ url: `${publicUrl.replace(/\/$/, "")}/api/attendee/webhooks`, triggers: ["bot.state_change"] }],
    automatic_leave_settings: {
      silence_timeout_seconds: body.automaticLeave?.silenceTimeoutSeconds ?? ATTENDEE_SILENCE_TIMEOUT_SECONDS,
      ...(body.automaticLeave?.silenceActivateAfterSeconds !== undefined ? { silence_activate_after_seconds: body.automaticLeave.silenceActivateAfterSeconds } : {}),
      ...(body.automaticLeave?.maxUptimeSeconds !== undefined ? { max_uptime_seconds: body.automaticLeave.maxUptimeSeconds } : {}),
    },
  };
  /**
   * The vendor's own transcript, in the meeting's language. Left to auto-detect it rendered a Japanese
   * meeting as confident English, which made it useless as evidence of what was said. The page query
   * already carries the language the character speaks; the transcript follows it.
   */
  const languageTag = body.botPageQuery?.language ?? "";
  const language = languageTag.split("-")[0]?.toLowerCase() ?? "";
  if (body.transcription === "closed_captions") {
    // Meet wants the full tag (ja-JP); Teams/Zoom take their own forms and are left to the vendor default.
    payload.transcription_settings = { meeting_closed_captions: { ...(/^[a-z]{2}-[A-Z]{2}$/.test(languageTag) ? { google_meet_language: languageTag } : {}), merge_consecutive_captions: true } };
  } else if (language) payload.transcription_settings = { deepgram: { language } };
  if (body.recording) payload.recording_settings = { ...(body.recording.view ? { view: body.recording.view } : {}), ...(body.recording.resolution ? { resolution: body.recording.resolution } : {}), ...(body.recording.format ? { format: body.recording.format } : {}) };
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

  const res = await fetchImpl(`${attendeeBase(env)}/api/v1/bots`, {
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
  deps.relay.bind(participantAudioToken, botId);
  deps.relay.bind(participantVideoToken, botId);
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
  const res = await fetchImpl(`${attendeeBase(env)}/api/v1/bots/${encodeURIComponent(botId)}/leave`, {
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
