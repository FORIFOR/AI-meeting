import { lifecycleToStatus, mapRecallStatus } from "@rcai/meeting-core";

/**
 * Recall.ai realtime payloads (docs.recall.ai/docs/real-time-event-payloads) and the broker
 * contract used by the browser connector. The API key never reaches the browser.
 */
export type RecallMode = "output_media" | "relay";

export interface CreateBotRequest {
  meetingUrl: string;
  botName: string;
  mode: RecallMode;
  /** BCP-47 language for recallai_streaming transcription (e.g. "ja"). */
  language?: string;
  /** Query string appended to the bot page URL in output_media mode (character/persona/engine). */
  botPageQuery?: Record<string, string>;
}

export interface CreateBotResponse {
  botId: string;
  /** Broker meeting session id (Round 3 Gate 5). */
  sessionId?: string;
  status: string;
  mode: RecallMode;
  /** ws(s) URL the browser opens to receive relayed realtime events (carries a signed client token). */
  clientWsUrl: string;
  /** Operator token (`Authorization: Bearer`) for /api/meeting/session/:id/{refresh,revoke}. */
  clientToken?: string;
  /** Public page URL the bot streams (output_media mode) — signed, single-use, ≤ 15 min. */
  botPageUrl?: string;
  botPageTokenExpiresAt?: number;
  region: string;
}

/** POST /api/meeting/session/activate response (bot page). */
export interface ActivateBotPageResponse {
  sessionId: string;
  botId: string;
  botName: string;
  mode: RecallMode;
  botPageQuery: Record<string, string>;
  clientWsUrl: string;
  clientToken: string;
  activations: number;
}

export interface BotStatusResponse {
  botId: string;
  /** Latest Recall status code (joining_call, in_waiting_room, in_call_not_recording, in_call_recording, call_ended, done, fatal). */
  code: string;
  subCode?: string | null;
  updatedAt?: string;
  statusChanges: { code: string; sub_code?: string | null; created_at?: string }[];
  meetingUrl?: string;
  /** Broker session bookkeeping (output_media watchdog). */
  sessionId?: string;
  botPageActivatedAt?: number | null;
  outputMediaRestarts?: number;
}

export interface RecallParticipant {
  id: number;
  name: string | null;
  is_host: boolean | null;
  platform: string | null;
  extra_data: object | null;
  email: string | null;
}

/** Realtime websocket envelope (subset). */
export interface RecallRealtimeMessage {
  event: string;
  data: {
    data: {
      buffer?: string;
      timestamp?: { relative: number; absolute?: string };
      words?: { text: string; start_timestamp?: { relative: number }; end_timestamp?: { relative: number } | null }[];
      language_code?: string;
      participant?: RecallParticipant;
      text?: string;
      to?: string;
    } | null;
    realtime_endpoint?: { id: string; metadata?: object };
    bot?: { id: string; metadata?: object };
    [k: string]: unknown;
  };
}

/** Message shape the broker relays to the browser client (Recall envelope + relay metadata). */
export interface RelayedMessage {
  relay: { botId: string; receivedAt: number };
  message: RecallRealtimeMessage;
}

export const RECALL_REALTIME_EVENTS = [
  "audio_mixed_raw.data",
  "transcript.data",
  "transcript.partial_data",
  "participant_events.join",
  "participant_events.leave",
  "participant_events.update",
  "participant_events.speech_on",
  "participant_events.speech_off",
] as const;

export const RECALL_REGIONS = ["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"] as const;
export type RecallRegion = (typeof RECALL_REGIONS)[number];

/** Recall bot status code (+ sub_code) → MeetingStatus, via the meeting-core lifecycle mapping. */
export function mapBotStatus(code: string, subCode?: string | null): import("@rcai/meeting-core").MeetingStatus {
  const m = mapRecallStatus(code, subCode);
  if (!m) return code === "done" ? "left" : "joining";
  return lifecycleToStatus(m.state);
}

export function wordsToText(words: { text: string }[] | undefined): string {
  if (!words?.length) return "";
  const joined = words.map((w) => w.text).join(" ");
  // Japanese providers emit tokens without spaces; collapse spaces between CJK chars.
  return joined.replace(/([぀-ヿ一-鿿＀-￯])\s+(?=[぀-ヿ一-鿿＀-￯])/g, "$1").trim();
}
