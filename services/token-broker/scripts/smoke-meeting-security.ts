/**
 * Round 3 Gate 5 smoke: real broker HTTP + websocket upgrade auth over real sockets.
 * Only Recall's API is mocked (no RECALL_API_KEY on this machine → BLOCKED_BY_RECALL_KEY for the live bot).
 * Usage: pnpm --filter @rcai/token-broker exec tsx scripts/smoke-meeting-security.ts
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { WebSocketServer, WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { RelayHub } from "../src/meeting-relay.js";
import { MeetingSessionRegistry } from "../src/meeting-session.js";
import { authorizeWebSocketUpgrade } from "../src/meeting-ws-auth.js";

const port = 8797;
const env = { RECALL_API_KEY: "mock", RECALL_REGION: "us-west-2", RECALL_PUBLIC_URL: `http://127.0.0.1:${port}`, RECALL_BOT_PAGE_URL: "http://localhost:5173", MEETING_TOKEN_SECRET: "smoke-secret-0123456789abcdef", PORT: String(port) };
const mockFetch = (async (url: string, init?: RequestInit) => {
  if (url.endsWith("/api/v1/bot/") && init?.method === "POST") return new Response(JSON.stringify({ id: "bot_smoke", status_changes: [{ code: "joining_call" }] }));
  if (url.endsWith("/api/v1/bot/bot_smoke/")) return new Response(JSON.stringify({ id: "bot_smoke", status_changes: [{ code: "in_call_recording" }] }));
  return new Response("{}", { status: 200 });
}) as unknown as typeof fetch;
const relay = new RelayHub(`ws://127.0.0.1:${port}`);
const sessions = new MeetingSessionRegistry(env.MEETING_TOKEN_SECRET);
const app = createApp({ env, relay, sessions, fetch: mockFetch });
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1", createServer }) as ReturnType<typeof createServer>;
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const auth = authorizeWebSocketUpgrade(req.url ?? "/", sessions, relay);
  if (!auth.ok) {
    socket.write(`HTTP/1.1 ${auth.status} ${auth.status === 401 ? "Unauthorized" : "Not Found"}\r\nX-Reason: ${auth.reason}\r\n\r\n`);
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (auth.kind === "client") {
      const remove = relay.addClient(auth.botId, { send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: () => ws.close() });
      ws.on("close", remove);
    } else {
      ws.on("message", (d) => relay.onRecallMessage(auth.token, d.toString()));
    }
  });
});

const rows: [string, string, string][] = [];
const base = `http://127.0.0.1:${port}`;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
function wsTry(url: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.on("open", () => { ws.close(); resolve("101 open"); });
    ws.on("unexpected-response", (_req, res) => resolve(`${res.statusCode} ${res.headers["x-reason"] ?? ""}`.trim()));
    ws.on("error", (e) => resolve(`error ${e.message}`));
  });
}

await new Promise((r) => setTimeout(r, 200));
const created = (await (await post("/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/smoke-test-url", botName: "Yui", mode: "output_media", botPageQuery: { character: "yui", persona: "friend_ja" } })).json()) as Record<string, string>;
rows.push(["POST /api/meeting/recall/bots (Recall mocked)", `200 botId=${created.botId} sessionId=${created.sessionId.slice(0, 8)}…`, "bot page URL: " + created.botPageUrl.replace(/token=.*/, "token=<signed, 15 min, single-use>")]);
const dup = await post("/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/smoke-test-url", mode: "output_media" });
rows.push(["duplicate join (same meeting URL)", `${dup.status} ${((await dup.json()) as { error: string }).error}`, "expect 409 DUPLICATE_JOIN"]);
rows.push(["client ws without token", await wsTry(`ws://127.0.0.1:${port}/api/meeting/recall/client/bot_smoke`), "expect 401 token_required"]);
rows.push(["client ws with valid client token", await wsTry(created.clientWsUrl), "expect 101 open"]);
rows.push(["client ws with token for another botId", await wsTry(created.clientWsUrl.replace("client/bot_smoke", "client/bot_other")), "expect 401 bot_mismatch"]);
rows.push(["relay ws with bogus token", await wsTry(`ws://127.0.0.1:${port}/api/meeting/recall/relay/bogus/`), "expect 401 malformed"]);
const pageToken = new URL(created.botPageUrl).searchParams.get("token")!;
const act1 = await post("/api/meeting/session/activate", { token: pageToken });
rows.push(["bot page activate (first load)", `${act1.status} ${JSON.stringify(((await act1.json()) as { botPageQuery: unknown }).botPageQuery)}`, "expect 200 + server-side render config"]);
const act2 = await post("/api/meeting/session/activate", { token: pageToken });
rows.push(["bot page activate (replayed URL)", `${act2.status} ${JSON.stringify(await act2.json())}`, "expect 401 replayed"]);
rows.push(["session status without operator token", `${(await fetch(`${base}/api/meeting/session/${created.sessionId}`)).status}`, "expect 401"]);
const st = await fetch(`${base}/api/meeting/session/${created.sessionId}`, { headers: { Authorization: `Bearer ${created.clientToken}` } });
rows.push(["session status with operator token", `${st.status} activations=${((await st.json()) as { activations: number }).activations}`, "expect 200 activations=1"]);
const ref = await post(`/api/meeting/session/${created.sessionId}/refresh`, { role: "bot_page" }, { Authorization: `Bearer ${created.clientToken}` });
rows.push(["refresh bot page token (operator)", `${ref.status}`, "expect 200 new single-use URL"]);
const rev = await post(`/api/meeting/session/${created.sessionId}/revoke`, {}, { Authorization: `Bearer ${created.clientToken}` });
rows.push(["revoke session (operator)", `${rev.status}`, "expect 200"]);
rows.push(["client ws after revoke", await wsTry(created.clientWsUrl), "expect 401 revoked"]);
rows.push(["bot page activate after revoke (fresh token)", `${(await post("/api/meeting/session/activate", { token: ((await ref.json()) as { token: string }).token })).status}`, "expect 401 revoked"]);
const created2 = (await (await post("/api/meeting/recall/bots", { meetingUrl: "https://meet.google.com/smoke-test-url", mode: "output_media", force: true })).json()) as Record<string, string>;
const leave = await post(`/api/meeting/recall/bots/${created2.botId}/leave`, {});
rows.push(["leave → session ended", `${leave.status}`, "expect 200"]);
rows.push(["client ws after leave", await wsTry(created2.clientWsUrl), "expect 401 ended"]);
console.log("| check | result | expectation |\n|---|---|---|");
for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} |`);
server.close();
process.exit(0);
