import type { RelayHub } from "./meeting-relay.js";
import type { MeetingSessionRegistry } from "./meeting-session.js";

export type UpgradeAuth =
  | { ok: true; kind: "relay"; token: string; botId: string }
  | { ok: true; kind: "client"; token: string; botId: string }
  | { ok: false; status: 401 | 404; reason: string };

/**
 * Authorises websocket upgrades (pure; unit-tested):
 *   /api/meeting/recall/relay/{relayToken}/         Recall → broker   (role relay, session live, bot bound)
 *   /api/meeting/recall/client/{botId}?token=…      browser → broker  (role client|bot_page, botId must match the session)
 */
export function authorizeWebSocketUpgrade(rawUrl: string, sessions: MeetingSessionRegistry, relay: Pick<RelayHub, "botIdForToken" | "isValidToken">, now?: number): UpgradeAuth {
  const url = new URL(rawUrl, "http://localhost");
  const relayMatch = url.pathname.match(/^\/api\/meeting\/recall\/relay\/([^/]+)\/?$/);
  const clientMatch = url.pathname.match(/^\/api\/meeting\/recall\/client\/([^/]+)$/);
  if (relayMatch) {
    const token = decodeURIComponent(relayMatch[1]!);
    const v = sessions.verify(token, { role: "relay", now });
    if (!v.ok) return { ok: false, status: 401, reason: v.reason };
    const botId = v.session.botId ?? relay.botIdForToken(token);
    if (!botId || !relay.isValidToken(token)) return { ok: false, status: 401, reason: "bot_not_bound" };
    return { ok: true, kind: "relay", token, botId };
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
