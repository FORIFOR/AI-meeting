/**
 * Smoke: drive the real HTTP boundary of the broker with correctly signed Recall webhooks.
 *
 *   pnpm --filter @rcai/token-broker exec tsx scripts/smoke-recall-webhooks.ts
 *
 * Uses the real workspace verification secret from services/token-broker/.env to sign, but never
 * prints it. Recall's own API is stubbed by a local fixture server so the smoke costs nothing and
 * needs no meeting — the webhook path, verification, queue, store and transcript persistence are all
 * the production code paths.
 */
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "../src/env.js";
import { signLikeRecall } from "../src/recall/verify.js";
import { MeetingStore } from "../src/recall/store.js";

const env = loadEnv();
const secret = env.RECALL_WEBHOOK_VERIFICATION_SECRET;
if (!secret) {
  console.log("BLOCKED_BY_RECALL_WEBHOOK_SECRET: set RECALL_WEBHOOK_VERIFICATION_SECRET in services/token-broker/.env");
  process.exit(2);
}
console.log(`verification secret loaded: ${secret.slice(0, 6)}… (${secret.length} chars, not printed)`);

const TRANSCRIPT = [
  { participant: { id: 1, name: "Shuhei" }, words: [{ text: "本日はよろしくお願いします", start_timestamp: { relative: 2.1 } }] },
  { participant: { id: 2, name: "Yui" }, words: [{ text: "こちらこそ、よろしくお願いします", start_timestamp: { relative: 5.4 } }] },
];

/** Stand-in for the Recall API: create_transcript + retrieve transcript + the download URL. */
const fixture = createServer((req, res) => {
  const url = req.url ?? "";
  res.setHeader("content-type", "application/json");
  if (url.endsWith("/create_transcript/")) return void res.end(JSON.stringify({ id: "t_smoke_1" }));
  if (url.includes("/transcript/t_smoke_1/")) return void res.end(JSON.stringify({ id: "t_smoke_1", data: { download_url: `http://127.0.0.1:${FIXTURE_PORT}/download/t_smoke_1.json` } }));
  if (url.startsWith("/download/")) return void res.end(JSON.stringify(TRANSCRIPT));
  res.statusCode = 404;
  res.end("{}");
});
const FIXTURE_PORT = 8899;

const dataDir = mkdtempSync(join(tmpdir(), "rcai-smoke-"));
const brokerPort = 8798;

async function main() {
  await new Promise<void>((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

  // The app under test, with Recall's base URL pointed at the fixture via the region host trick:
  // the client builds https://{region}.recall.ai, so we inject a fetch that rewrites that origin.
  const { createApp } = await import("../src/app.js");
  const { serve } = await import("@hono/node-server");
  const rewriting: typeof fetch = (input, init) => {
    const url = String(input).replace(/^https:\/\/[a-z0-9-]+\.recall\.ai\/api\/v1/, `http://127.0.0.1:${FIXTURE_PORT}`);
    return fetch(url, init);
  };
  const store = new MeetingStore(dataDir);
  const app = createApp({
    env: { ...env, RECALL_DATA_DIR: dataDir, PORT: String(brokerPort) },
    fetch: rewriting,
    store,
    startWorker: false, // the route drains inline so the smoke is deterministic
  });
  const server = serve({ fetch: app.fetch, port: brokerPort });
  await new Promise((r) => setTimeout(r, 300));

  const rec = store.createIntent({ meetingUrl: "https://meet.google.com/smoke-test-abc", botName: "Yui" });
  store.update(rec.id, { botId: "bot_smoke_1", status: "joining_call" }, "bot_created");
  console.log(`\nmeeting record ${rec.id} → status=${store.get(rec.id)!.status}`);

  const post = async (event: string, data: unknown, id: string) => {
    const body = JSON.stringify({ event, data });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`http://127.0.0.1:${brokerPort}/api/recall/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": signLikeRecall(secret, id, ts, body) },
      body,
    });
    console.log(`POST /api/recall/webhooks ${event} → ${res.status} ${JSON.stringify(await res.json())}`);
  };

  // 1) unsigned request must be rejected before any processing
  const bad = await fetch(`http://127.0.0.1:${brokerPort}/api/recall/webhooks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: "recording.done" }) });
  console.log(`unsigned POST → ${bad.status} (expected 401)`);

  // 2) the real lifecycle
  await post("bot.in_call_recording", { bot: { id: "bot_smoke_1" }, data: { code: "in_call_recording", sub_code: null } }, "msg_smoke_1");
  await post("recording.done", { recording: { id: "rec_smoke_1" }, bot: { id: "bot_smoke_1" } }, "msg_smoke_2");
  await post("transcript.done", { transcript: { id: "t_smoke_1", recording: { id: "rec_smoke_1" } } }, "msg_smoke_3");
  await post("transcript.done", { transcript: { id: "t_smoke_1", recording: { id: "rec_smoke_1" } } }, "msg_smoke_3"); // replay

  const after = store.get(rec.id)!;
  console.log("\nstore transitions:", after.lifecycle.map((l) => l.event).join(" → "));
  console.log("recordingId:", after.recordingId, "transcriptId:", after.transcriptId);
  const detail = await (await fetch(`http://127.0.0.1:${brokerPort}/api/meetings/${rec.id}/transcript`)).json();
  console.log("\nGET /api/meetings/:id/transcript →\n" + (detail as { text: string }).text);
  console.log("\npersisted file:", join(store.root, after.transcriptPath!));
  console.log(readFileSync(join(store.root, after.transcriptTextPath!), "utf8"));

  server.close();
  fixture.close();
  console.log("\nSMOKE OK");
}

main().catch((e) => {
  console.error("SMOKE FAILED", e);
  fixture.close();
  process.exit(1);
});
