/** Real broker + real Gemini sockets. No generated speech, fixture server or credentials in reports. */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { GeminiLiveProvider, type WebSocketLike } from "../../../../providers/gemini/src/geminiLiveProvider.js";
import type { SessionConfig } from "../../../../packages/conversation-core/src/index.js";
import { getPersona } from "../../../../personas/src/catalog.js";

const brokerUrl = process.env.BROKER_URL ?? "http://127.0.0.1:8787";
const out = resolve(process.env.OUT ?? "docs/reports/release/gemini-lifecycle.json");
const NetworkWebSocket = createRequire(new URL("../../../../services/token-broker/package.json", import.meta.url))("ws") as typeof WebSocket;
let offlineUntil = 0;
const sockets: (WebSocket & { terminate(): void })[] = [];
const setupHandles: (string | undefined)[] = [];
const serverHandles = new Set<string>();
const rows: { check: string; status: string; detail?: string }[] = [];
const observations: Record<string, number> = {};
let phase = "preflight";
let readyCount = 0;
let eventCount = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const waitFor = async (predicate: () => boolean, ms = 20_000) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(50);
  if (!predicate()) throw new Error(`observation timed out: ${phase}`);
};
const check = (name: string, ok: boolean) => {
  rows.push({ check: name, status: ok ? "PASS" : "FAIL" });
  if (!ok) throw new Error(name);
};
const provider = new GeminiLiveProvider({
  brokerUrl,
  fetchImpl: async (url, init) => { if(Date.now()<offlineUntil) throw new Error("Injected network offline"); return fetch(url,init); },
  forceRealtimeText: true,
  wsFactory: (url) => {
    const socket = new NetworkWebSocket(url) as WebSocket & { terminate(): void };
    sockets.push(socket);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      const message = JSON.parse(String(data));
      for (const key of Object.keys(message)) observations[`sent.${key}`] = (observations[`sent.${key}`] ?? 0) + 1;
      if (message.setup) {
        setupHandles.push(message.setup.sessionResumption?.handle);
        check("setup requests resumption and compression", !!message.setup.sessionResumption && !!message.setup.contextWindowCompression?.slidingWindow);
      }
      send(data);
    };
    socket.addEventListener("message", async (event) => {
      const text = typeof event.data === "string" ? event.data : event.data instanceof Blob ? await event.data.text() : new TextDecoder().decode(event.data);
      const message = JSON.parse(text);
      for (const key of Object.keys(message)) observations[key] = (observations[key] ?? 0) + 1;
      const update = message.sessionResumptionUpdate;
      if (update) {
        for (const key of Object.keys(update)) observations[`resumption.${key}`] = (observations[`resumption.${key}`] ?? 0) + 1;
      }
      if (update?.resumable && update.newHandle) serverHandles.add(update.newHandle);
    });
    return socket as unknown as WebSocketLike;
  },
});
provider.onEvent((event) => { eventCount++; observations[`event.${event.type}`] = (observations[`event.${event.type}`] ?? 0) + 1; if (event.type === "session_ready") readyCount++; });
const persona = getPersona("friend_ja");
const config: SessionConfig = {
  systemPrompt: persona.systemPrompt, mode: persona.mode, language: persona.language,
  privacyMode: "default", personaId: persona.id,
  providerOptions: { opening: persona.opening },
};
try {
  const health = await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(3000) });
  if (!health.ok || !(await health.json()).providers?.google) throw new Error("BLOCKED_BY_GEMINI_BROKER");
  await provider.connect(config);
  check("real initial connection", readyCount === 1 && setupHandles[0] === undefined);
  // Exercise the application's real context-update path; idle sockets need not receive handles.
  phase = "resumption handle";
  await waitFor(() => serverHandles.size > 0, 20_000);
  // Cut the real TCP transport. A close handshake can be acknowledged as 1000 (normal leave).
  offlineUntil=Date.now()+10000;
  sockets.at(-1)!.terminate();
  phase = "network reconnect";
  await waitFor(() => readyCount === 2);
  check("network reconnect uses a real session handle", !!setupHandles[1] && serverHandles.has(setupHandles[1]!));
  await provider.disconnect();
  const stoppedEvents = eventCount;
  await waitFor(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED));
  await sleep(1000);
  check("no events after leaving", eventCount === stoppedEvents);
  await provider.connect(config);
  check("new conversation has no previous handle", setupHandles.at(-1) === undefined && readyCount === 3);
  await provider.disconnect();
  const beforeCancel = sockets.length;
  const pending = provider.connect(config).then(() => false, () => true);
  await sleep(10);
  await provider.disconnect();
  check("leave cancels pending token request", await pending);
  await sleep(1000);
  check("cancelled connection leaves no live socket", sockets.slice(beforeCancel).every((socket) => socket.readyState === WebSocket.CLOSED) && readyCount === 3);
  const first = provider.connect(config).then(() => false, () => true);
  const second = provider.connect(config);
  check("overlapping connect cancels older conversation", await first);
  await second;
  check("only latest conversation becomes ready", readyCount === 4 && setupHandles.at(-1) === undefined);
} catch (error) {
  // Error strings from vendors may contain credentials. Keep failure categories, never payloads.
  const safe = error instanceof Error ? error.message.replace(/(access_token|key|token)[^\s]*/gi, "$1=redacted").slice(0, 180) : "unknown";
  rows.push({ check: "live lifecycle completion", status: rows.length ? "FAIL" : "BLOCKED", detail: error instanceof Error && error.message === "BLOCKED_BY_GEMINI_BROKER" ? error.message : `Live connection or observation failed: ${safe}` });
} finally {
  await provider.disconnect();
  await waitFor(() => sockets.every((socket) => socket.readyState === WebSocket.CLOSED), 5000).catch(() => {
    rows.push({ check: "all sockets closed", status: "FAIL" });
  });
  mkdirSync(resolve(out, ".."), { recursive: true });
  const status = rows.some((r) => r.status === "FAIL") ? "FAIL" : rows.some((r) => r.status === "BLOCKED") ? "BLOCKED" : "PASS";
  const report = { schemaVersion: 1, measuredAt: new Date().toISOString(), scope: "Real Gemini TCP disconnected, token transport blocked for 10 seconds by fault injection; no physical network claim", status, phase, observations, rows };
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = status === "PASS" ? 0 : status === "BLOCKED" ? 2 : 1;
}
