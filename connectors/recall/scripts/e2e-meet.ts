/**
 * Reality Gate harness: Google Meet / Zoom participation through Recall.ai via the token broker.
 *   RECALL_API_KEY + RECALL_PUBLIC_URL (+ RECALL_BOT_PAGE_URL for output_media) must be set for the broker,
 *   MEET_URL = the meeting to join, BROKER_URL (default http://localhost:8787), MODE=relay|output_media (default relay
 *   so this script can observe audio/transcript itself), TEST_WAV = optional 24 kHz mono WAV to play into the meeting
 *   (relay mode, needs an MP3 encoder → BLOCKED_BY_MP3_ENCODER is reported, not faked).
 * Prints a PASS/FAIL table for: join → audio received → LISTENING → addressed → THINKING → response → audio out → LISTENING.
 */
import { WebSocket } from "ws";
import { ParticipationPolicy } from "@rcai/meeting-core";
import { RecallConnector, type WebSocketLike } from "../src/index.js";

const key = process.env.RECALL_API_KEY;
const brokerUrl = process.env.BROKER_URL ?? "http://localhost:8787";
const meetUrl = process.env.MEET_URL;
const mode = (process.env.MODE ?? "relay") as "relay" | "output_media";
const names = (process.env.CHARACTER_NAMES ?? "Yui,ゆい,結衣").split(",");
const durationMs = Number(process.env.DURATION_MS ?? 120_000);

const rows: { step: string; status: "PASS" | "FAIL" | "BLOCKED" | "SKIP"; detail?: string }[] = [];
const row = (step: string, status: (typeof rows)[number]["status"], detail?: string) => rows.push({ step, status, detail });
const finish = (code: number) => {
  console.log("\n| step | status | detail |\n|---|---|---|");
  for (const r of rows) console.log(`| ${r.step} | ${r.status} | ${r.detail ?? ""} |`);
  process.exit(code);
};

if (!key) {
  row("credentials", "BLOCKED", "BLOCKED_BY_RECALL_KEY — set RECALL_API_KEY (broker .env) and re-run");
  finish(2);
}
if (!meetUrl) {
  row("meeting url", "BLOCKED", "MEET_URL not set");
  finish(2);
}

const health = await fetch(`${brokerUrl}/health`).then((r) => r.json() as Promise<{ meeting?: { recall: boolean; recallPublicUrl: boolean } }>).catch(() => null);
if (!health?.meeting?.recall) {
  row("broker", "BLOCKED", "broker reports recall=false (RECALL_API_KEY missing in services/token-broker/.env)");
  finish(2);
}
if (!health?.meeting?.recallPublicUrl) {
  row("broker", "BLOCKED", "BLOCKED_BY_RECALL_PUBLIC_URL — expose the broker with ngrok/cloudflared and set RECALL_PUBLIC_URL");
  finish(2);
}

const connector = new RecallConnector({ brokerUrl, mode, wsFactory: (u) => new WebSocket(u) as unknown as WebSocketLike, pollIntervalMs: 2000 });
const policy = new ParticipationPolicy({ names, proactivity: "addressed_only" });
const t0 = Date.now();
let audioFrames = 0;
let transcripts = 0;
let joinedAt = 0;
let addressedAt = 0;
let firstAudioAt = 0;
const session = await connector.join({ meetingUrl: meetUrl!, displayName: names[0]!, privacyMode: "default", language: "ja" });
row("create bot", "PASS", `botId=${session.id} platform=${session.platform}`);
session.onEvent((e) => {
  const at = Date.now() - t0;
  switch (e.type) {
    case "status":
      console.log(`[${at}ms] status ${e.status} (${e.detail ?? ""})`);
      break;
    case "joined":
      joinedAt = at;
      console.log(`[${at}ms] joined`);
      break;
    case "audio":
      audioFrames++;
      if (!firstAudioAt) firstAudioAt = at;
      break;
    case "transcript": {
      transcripts++;
      console.log(`[${at}ms] ${e.final ? "final" : "partial"} ${e.speakerName ?? "?"}: ${e.text}`);
      policy.onTranscript({ text: e.text, final: e.final, speakerName: e.speakerName }, at);
      if (policy.state === "ADDRESSED" && !addressedAt) addressedAt = at;
      break;
    }
    case "speech":
      policy.onSpeechActivity(e.active, at, e.participant.name);
      break;
    case "left":
      console.log(`[${at}ms] left ${e.reason ?? ""}`);
      break;
    case "error":
      console.log(`[${at}ms] error ${e.error.message}`);
      break;
    default:
      break;
  }
});

await new Promise((r) => setTimeout(r, durationMs));
row("bot joined (in_call_recording)", joinedAt ? "PASS" : "FAIL", joinedAt ? `${joinedAt} ms after create` : "never reached in_call_recording");
row("meeting audio received", audioFrames > 0 ? "PASS" : "FAIL", `${audioFrames} frames (first at ${firstAudioAt} ms)`);
row("transcript received (LISTENING)", transcripts > 0 ? "PASS" : "FAIL", `${transcripts} segments`);
row("addressed by name → ADDRESSED", addressedAt ? "PASS" : "FAIL", addressedAt ? `${addressedAt} ms` : `say "${names[0]}さん、どう思う？" in the meeting`);
row("THINKING → response → audio out", mode === "output_media" ? "SKIP" : "BLOCKED", mode === "output_media" ? "verify in the bot page (web app bot mode) — audio/video are native there" : "relay mode needs an MP3 encoder (BLOCKED_BY_MP3_ENCODER); use MODE=output_media with the web app");
await session.leave();
row("leave", "PASS");
finish(rows.some((r) => r.status === "FAIL") ? 1 : 0);
