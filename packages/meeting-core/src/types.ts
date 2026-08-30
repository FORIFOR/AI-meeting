import type { PCMFrame } from "@rcai/audio-core";
import type { PrivacyMode } from "@rcai/conversation-core";

/**
 * MeetingConnector (spec addendum P0-1): lets a character join a video meeting as a participant.
 * Neither the UI nor the ConversationRuntime depend on a vendor (Recall / Zoom / Google) directly.
 */
export type MeetingPlatform = "google_meet" | "zoom" | "teams" | "webex" | "unknown";

export type MeetingConnectorId = "recall" | "zoom_native" | "google_native";

export type MeetingStatus =
  | "created"
  | "joining"
  | "waiting_room"
  | "in_call_not_recording"
  | "in_call"
  /** relay / media link dropped; trying to resume (Round 3 lifecycle) */
  | "reconnecting"
  | "leaving"
  /** we left on purpose */
  | "left"
  /** host denied / waiting-room timeout / bot blocked */
  | "denied"
  /** host kicked the bot out of an active call */
  | "removed"
  /** the meeting itself ended */
  | "ended"
  | "failed";

export interface MeetingConnectorCapabilities {
  platforms: Exclude<MeetingPlatform, "unknown">[];
  /** How the character's voice reaches the meeting. */
  audioOut: "pcm_stream" | "clip" | "none";
  separateParticipantAudio: boolean;
  realtimeTranscript: boolean;
  /** Whether the character's video (avatar) can be shown as the bot's camera. */
  videoOut: boolean;
}

export interface JoinRequest {
  meetingUrl: string;
  displayName: string;
  privacyMode: PrivacyMode;
  /** BCP-47 language for the meeting transcription (e.g. "ja"). */
  language?: string;
  /** Connector-specific options (never secrets). */
  options?: Record<string, string | number | boolean | undefined>;
}

export interface MeetingParticipant {
  id: string;
  name: string | null;
  isHost?: boolean;
  isSelf?: boolean;
}

export type MeetingEvent =
  | { type: "status"; status: MeetingStatus; detail?: string; at: number }
  | { type: "joined"; at: number }
  | { type: "left"; reason?: string; at: number }
  | { type: "audio"; frame: PCMFrame; participantId?: string }
  | { type: "transcript"; text: string; final: boolean; participantId?: string; speakerName?: string | null; at: number }
  | { type: "participant_joined"; participant: MeetingParticipant; at: number }
  | { type: "participant_left"; participant: MeetingParticipant; at: number }
  | { type: "speech"; participant: MeetingParticipant; active: boolean; at: number }
  /** Host muted / unmuted the character; outbound audio must pause while muted. */
  | { type: "audio_muted"; muted: boolean; at: number }
  | { type: "error"; error: Error };

export type MeetingEventListener = (e: MeetingEvent) => void;

export interface MeetingSession {
  readonly id: string;
  readonly platform: MeetingPlatform;
  status(): MeetingStatus;
  onEvent(cb: MeetingEventListener): () => void;
  /** The character's voice (internal 48 kHz frames) → meeting. */
  pushOutboundAudio(frame: PCMFrame): void;
  /** Marks the end of an utterance so clip-based connectors can flush. */
  endOutboundUtterance?(): Promise<void>;
  leave(): Promise<void>;
}

export interface MeetingConnector {
  readonly id: MeetingConnectorId;
  capabilities(): MeetingConnectorCapabilities;
  join(req: JoinRequest): Promise<MeetingSession>;
}

export function detectPlatform(meetingUrl: string): MeetingPlatform {
  let host = "";
  try {
    host = new URL(meetingUrl).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (host === "meet.google.com") return "google_meet";
  if (host.endsWith("zoom.us") || host.endsWith("zoom.com")) return "zoom";
  if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "teams";
  if (host.endsWith("webex.com")) return "webex";
  return "unknown";
}
