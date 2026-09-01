import type { RelayHub } from "./meeting-relay.js";
import type { MeetingSessionRegistry } from "./meeting-session.js";

/**
 * Which of a vendor's streams a relay socket is carrying.
 *
 * Only the mixed-audio socket is bidirectional — it is the one the character's voice can leave by —
 * so the others must not be registered as the vendor, or the last one to connect would swallow the
 * reply and nothing would say why.
 */
export type RelayStream = "mixed" | "participant_audio" | "participant_video";

export type UpgradeAuth =
  | { ok: true; kind: "relay"; token: string; botId: string; stream: RelayStream }
  | { ok: true; kind: "client"; token: string; botId: string }
  | { ok: false; status: 401 | 404; reason: string };

/**
 * Authorises websocket upgrades (pure; unit-tested):
 *   /api/meeting/recall/relay/{relayToken}/         Recall → broker   (role relay, session live, bot bound)
 *   /api/meeting/attendee/participant-audio/{relayToken}/  Attendee → broker (one stream per speaker)
 *   /api/meeting/attendee/participant-video/{relayToken}/  Attendee → broker (webcam frames per speaker)
 *   /api/meeting/recall/client/{botId}?token=…      browser → broker  (role client|bot_page, botId must match the session)
 */
export function authorizeWebSocketUpgrade(rawUrl: string, sessions: MeetingSessionRegistry, relay: Pick<RelayHub, "botIdForToken" | "isValidToken">, now?: number): UpgradeAuth {
  const url = new URL(rawUrl, "http://localhost");
  // One relay, two vendors: Recall pushes on its realtime endpoint, Attendee streams audio both ways.
  const relayMatch = url.pathname.match(/^\/api\/meeting\/(?:recall\/relay|attendee\/audio|attendee\/(participant-audio|participant-video))\/([^/]+)\/?$/);
  const clientMatch = url.pathname.match(/^\/api\/meeting\/(?:recall|attendee)\/client\/([^/]+)$/);
  if (relayMatch) {
    const token = decodeURIComponent(relayMatch[2]!);
    const stream: RelayStream = relayMatch[1] === "participant-audio" ? "participant_audio" : relayMatch[1] === "participant-video" ? "participant_video" : "mixed";
    const v = sessions.verify(token, { role: "relay", now });
    if (!v.ok) return { ok: false, status: 401, reason: v.reason };
    const botId = v.session.botId ?? relay.botIdForToken(token);
    if (!botId || !relay.isValidToken(token)) return { ok: false, status: 401, reason: "bot_not_bound" };
    return { ok: true, kind: "relay", token, botId, stream };
  }
  if (clientMatch) {
    const botId = decodeURIComponent(clientMatch[1]!);
    const token = url.searchParams.get("token") ?? "";
    if (!token) return { ok: false, status: 401, reason: "token_required" };
    const v = sessions.verify(token, { role: ["client", "bot_page"], botId, now });
    if (!v.ok) return { ok: false, status: 401, reason: v.reason };
    return { ok: true, kind: "client", token, botId };
  }
  return { ok: false, status: 404, reason: "unknown_path" };
}
