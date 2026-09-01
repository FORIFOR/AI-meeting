import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import { RelayHub } from "./meeting-relay.js";
import { publicWsBase } from "./routes/meeting.js";
import { MeetingSessionRegistry } from "./meeting-session.js";
import { authorizeWebSocketUpgrade } from "./meeting-ws-auth.js";

const env = loadEnv();
const port = Number(env.PORT ?? 8787);
/**
 * The relay's client URL is handed to the bot page, which runs inside Recall's browser where loopback is
 * blocked — a localhost base is unreachable there by construction. Use the public origin when the meeting
 * connector is configured.
 */
const relay = new RelayHub(env.RECALL_PUBLIC_URL ? publicWsBase(env.RECALL_PUBLIC_URL) : `ws://localhost:${port}`);
const sessions = new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET);
if (sessions.secretSource === "ephemeral") console.warn("[token-broker] MEETING_TOKEN_SECRET not set — using an ephemeral secret (meeting tokens are invalid after restart)");
const app = createApp({ env, relay, sessions });
// TTL sweeper: ended/revoked sessions are dropped after 5 min, idle live sessions after 6 h.
setInterval(() => {
  for (const id of sessions.sweep()) console.log(`[token-broker] meeting session swept ${id.slice(0, 8)}…`);
}, 60_000).unref();

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1", createServer }, (info) => {
  const configured = Object.entries({ openai: env.OPENAI_API_KEY, google: env.GEMINI_API_KEY, livekit: env.LIVEKIT_API_KEY, heygen: env.HEYGEN_API_KEY, tavus: env.TAVUS_API_KEY, recall: env.RECALL_API_KEY })
    .filter(([, v]) => Boolean(v))
    .map(([k]) => k);
  // Keys are never printed — only which providers are configured.
  console.log(`[token-broker] listening on http://127.0.0.1:${info.port} configured=[${configured.join(",") || "none"}]`);
}) as ReturnType<typeof createServer>;

/**
 * Meeting relay websockets:
 *   /api/meeting/recall/relay/{token}/   ← Recall realtime endpoint (public side; reached through RECALL_PUBLIC_URL)
 *   /api/meeting/recall/client/{botId}   ← browser (operator UI / bot page)
 */
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const auth = authorizeWebSocketUpgrade(req.url ?? "/", sessions, relay);
  if (!auth.ok) {
    if (auth.status === 401) socket.write(`HTTP/1.1 401 Unauthorized\r\nX-Reason: ${auth.reason}\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    if (auth.kind === "relay") {
      const { token, botId, stream } = auth;
      console.log(`[token-broker] relay connected bot=${botId.slice(0, 8)}… stream=${stream}`);
      ws.on("message", (data) => {
        // Re-check on every message: revoke/end must cut the feed immediately.
        if (!sessions.verify(token, { role: "relay", botId }).ok) {
          ws.close(1008, "session revoked");
          return;
        }
        relay.onRecallMessage(token, data.toString());
        const s = sessions.byBot(botId);
        if (s) sessions.touch(s.id);
      });
      // Only the bidirectional stream is the vendor: the per-participant sockets are receive-only,
      // and registering one of them would send the character's voice into a socket nobody reads.
      if (stream === "mixed") relay.setVendor(botId, { send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: () => ws.close() });
      const ping = setInterval(() => ws.ping(), 25_000); // keep tunnels/load balancers from idling out
      ws.on("close", () => {
        clearInterval(ping);
        if (stream === "mixed") relay.setVendor(botId, null);
      });
    } else {
      const { botId, token } = auth;
      const remove = relay.addClient(botId, { send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: () => ws.close() });
      // Client → vendor: Attendee takes the character's audio back on the same socket it sends on.
      ws.on("message", (data) => {
        if (!sessions.verify(token, { role: ["client", "bot_page"], botId }).ok) return;
        relay.sendToVendor(botId, data.toString());
      });
      const guard = setInterval(() => {
        if (!sessions.verify(token, { role: ["client", "bot_page"], botId }).ok) ws.close(1008, "session expired or revoked");
      }, 10_000);
      ws.on("close", () => {
        clearInterval(guard);
        remove();
      });
    }
  });
});
