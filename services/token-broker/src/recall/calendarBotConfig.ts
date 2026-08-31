import type { SchedulableEvent } from "@rcai/meeting-core";
import type { BrokerEnv } from "../env.js";
import type { MeetingSessionRegistry } from "../meeting-session.js";
import { RECALL_EVENTS, botVariant, publicWsBase, streamingTranscript, type RelayRegistry } from "../routes/meeting.js";
import type { BotConfigFactory } from "./calendarSync.js";

/**
 * `bot_config` for calendar-scheduled bots. Schedule Bot For Calendar Event has no partial update,
 * so each phase sends a complete object; Recall fills `meeting_url` and `join_at` from the event.
 *
 * Phase 1 (reserve) carries no tokenised URL: a `bot_page` session token lives 15 minutes, and a
 * calendar event can be days away. Phase 2 (arm) runs shortly before the start and swaps in a fresh
 * relay websocket and Output Media page, which is exactly the window the Scheduling Guide asks for.
 */
export function calendarBotConfig(env: BrokerEnv, sessions: MeetingSessionRegistry, relay: RelayRegistry): BotConfigFactory {
  const botName = env.RECALL_BOT_NAME ?? "Yui";
  const language = (env.RECALL_TRANSCRIPT_LANGUAGE ?? "ja").split("-")[0] || "ja";

  return {
    reserve(): Record<string, unknown> {
      return { bot_name: botName };
    },

    bind(sessionId: string, botId: string): void {
      sessions.bindBot(sessionId, botId);
    },

    arm(event: SchedulableEvent, meetingRecordId?: string): Record<string, unknown> | null {
      const publicUrl = env.RECALL_PUBLIC_URL;
      const botPage = env.RECALL_BOT_PAGE_URL;
      if (!publicUrl || !botPage) return null;

      const session = sessions.create({ meetingUrl: event.meetingUrl ?? "", botName, mode: "output_media" });
      const relayToken = sessions.issue(session.id, "relay", { brokerPublicUrl: publicUrl });
      relay.register(relayToken);
      const pageToken = sessions.issue(session.id, "bot_page", { brokerPublicUrl: publicUrl });
      const pageUrl = `${botPage.replace(/\/$/, "")}/?${new URLSearchParams({ rcai_bot: "1", token: pageToken })}`;

      return {
        bot_name: botName,
        recording_config: {
          audio_mixed_raw: {},
          transcript: { provider: streamingTranscript(language) },
          realtime_endpoints: [
            { type: "websocket", url: `${publicWsBase(publicUrl)}/api/meeting/recall/relay/${encodeURIComponent(relayToken)}/`, events: RECALL_EVENTS },
          ],
          include_bot_in_recording: { audio: true },
        },
        output_media: { camera: { kind: "webpage", config: { url: pageUrl } } },
        variant: botVariant(env),
        metadata: {
          app: "rcai",
          mode: "output_media",
          source: "calendar",
          sessionId: session.id,
          calendarEventId: event.id,
          ...(meetingRecordId ? { meetingRecordId } : {}),
        },
      };
    },
  };
}
