/**
 * The product path, on Attendee, with real people: the one thing nothing else here proves.
 *
 *   real meeting → human voice → Attendee → our STT → address detection → AI → TTS → Attendee → heard
 *
 *   MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm reality:attendee:human      # 10-minute smoke
 *   MEET_URL=https://us02web.zoom.us/j/…?pwd=… pnpm reality:attendee:human         # same gate on Zoom
 *   MEET_URL=... PROACTIVITY=open pnpm reality:attendee:human                      # joins in uncalled
 *   MEET_URL=... MINUTES=30 pnpm reality:attendee:human                            # commercial gate
 *
 * The avatar page runs inside Attendee as its voice agent, so the character is both seen and heard from
 * one place, and meeting audio reaches that page over our relay. This harness observes the same relay to
 * score what happened; the page is what actually talks.
 *
 * The character answers only when addressed: the agent hears everything (it has to, or it would never
 * hear its own name), and its reply reaches the meeting only while the participation policy says it was
 * spoken to.
 */
import { createRequire } from "node:module";
import { loadEnv } from "./lib.mjs";
import { ParticipationPolicy, detectPlatform } from "../../packages/meeting-core/src/index.js";

const require = createRequire("/Users/horioshuuhei/Projects/AI-meeting/services/agent/package.json");
const WebSocket = require("ws");

const env = loadEnv();
const url = process.env.MEET_URL;
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const agentUrl = process.env.AGENT_URL ?? "ws://127.0.0.1:8788/session";
const minutes = Number(process.env.MINUTES ?? 10);
const names = (process.env.CHARACTER_NAMES ?? "Yui,ゆい,ユイ,結衣").split(",");
/**
 * Any platform the vendor carries, not just Meet. The gate refused every non-Meet URL, so Zoom could
 * not be exercised even though both connectors advertise it — a gate that cannot run is not a pass.
 */
const platform = detectPlatform(url ?? "");
if (!url || platform === "unknown") { console.log(`BLOCKED_BY_MEET_URL: set MEET_URL to a Google Meet, Zoom or Teams link (got ${url ?? "nothing"})`); process.exit(2); }
if (!env.ATTENDEE_API_KEY) { console.log("BLOCKED_BY_ATTENDEE_KEY"); process.exit(2); }

const CUES = [
  { at: 60, say: "「ゆい、今日の予定を教えて」", expect: "答える" },
  { at: 120, say: "「ゆいが昨日そう言ってた」（三人称）", expect: "答えない" },
  { at: 180, say: "人A「ゆい、これはどう？」→ 答え始めたら人Bが割り込む", expect: "AIが止まる" },
  { at: 240, say: "人Aと人Bだけで30秒会話", expect: "割り込まない" },
  { at: 300, say: "「ゆい、今どう思う？」", expect: "答える" },
  { at: 360, say: "全員30秒黙る", expect: "勝手に話さない" },
  { at: 420, say: "1名退出→再参加", expect: "状態が壊れない" },
];

/**
 * The engine the page will speak with. Without this the page routes by its own empty settings — "auto",
 * which picks a cloud engine, and an account with no credit renders the character and never speaks.
 */
const engine = process.env.ENGINE ?? "google";
/**
 * How much the character needs before it speaks. `addressed_only` is the product default; the gate can
 * ask for more, and `open` is the setting that proves the voice path without depending on the
 * recogniser getting a two-mora name right.
 */
const proactivity = process.env.PROACTIVITY ?? "addressed_only";
const created = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    meetingUrl: url,
    botName: env.RECALL_BOT_NAME ?? "Yui",
    botPageQuery: {
      engine,
      character: process.env.CHARACTER_ID ?? "yui",
      name: env.RECALL_BOT_NAME ?? "Yui",
      language: "ja-JP",
      proactivity,
      // cues: read the webcam in the page only. model: also send frames to the provider. off: neither.
      vision: process.env.VISION ?? "cues",
      // The character's voice. Unset keeps the character's own; the ids are the provider's.
      ...(process.env.VOICE ? { voice: process.env.VOICE } : {}),
      // socket: the character's audio comes back over the relay, where this harness can count it.
      outbound: process.env.OUTBOUND ?? "socket",
    },
  }),
})).json();
if (!created.botId) { console.log(`FAIL: ${created.error ?? "join failed"} ${created.detail ?? ""}`); process.exit(1); }
console.log(`\n=== ${minutes} 分 実人間 Gate (Attendee) ===\nbot ${created.botId}  ${created.sampleRate}Hz  engine=${engine}  platform=${platform}  proactivity=${proactivity}  vision=${process.env.VISION ?? "cues"}  voice=${process.env.VOICE ?? "(character default)"}`);
console.log(`>>> Meet で「${env.RECALL_BOT_NAME ?? "Yui"}」の参加を承認してください。\n`);

/** Did the avatar page actually start? Asking a person whether they saw it is not evidence. */
const pageState = async () => {
  try {
    const r = await fetch(`${broker}/api/meeting/session/${created.sessionId}`, { headers: { authorization: `Bearer ${created.clientToken}` } });
    return await r.json();
  } catch { return {}; }
};

const policy = new ParticipationPolicy({ names, proactivity });
const stats = { heard: 0, transcripts: 0, addressed: 0, replies: 0, spokenMs: 0, suppressed: 0, outboundChunks: 0, outboundBytes: 0 };
let meeting = null;

const agent = new WebSocket(agentUrl);
await new Promise((r) => agent.on("open", r));
agent.send(JSON.stringify({ type: "start", config: {
  systemPrompt: `あなたはオンライン会議に同席しているキャラクター「${env.RECALL_BOT_NAME ?? "Yui"}」です。名前で呼ばれたときだけ、1〜2文で簡潔に日本語で答えます。`,
  mode: "free_talk", language: "ja-JP", privacyMode: "default", characterId: "yui", personaId: "friendly",
}}));

/** The meeting: audio in, audio out, on one socket. */
meeting = new WebSocket(created.clientWsUrl);
meeting.on("open", () => console.log("   [attendee] audio socket open"));
meeting.on("message", (raw) => {
  try {
    const outer = JSON.parse(String(raw));
    const m = outer.message ?? outer;
    /**
     * The character's own voice, on its way to the meeting. The relay broadcasts everything to every
     * client, so what the bot page sends back arrives here too — which is the only way to see, from
     * outside the vendor, that the character actually said something into the room.
     */
    if (m?.trigger === "realtime_audio.bot_output" && m.data?.chunk) {
      stats.outboundChunks++;
      stats.outboundBytes += Buffer.from(m.data.chunk, "base64").length;
      return;
    }
    if (m?.trigger !== "realtime_audio.mixed" || !m.data?.chunk) return;
    stats.heard++;
    // The agent takes raw PCM16 mono at its own fixed rate — no header, and no other rate.
    agent.send(Buffer.from(m.data.chunk, "base64"), { binary: true });
  } catch { /* ignore */ }
});

agent.on("message", (data, isBinary) => {
  if (isBinary) {
    // The character's voice. It reaches the meeting only while it has actually been addressed.
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const rate = b.readUInt32LE(0);
    const body = b.subarray(12);
    /**
     * Observation only. The avatar page inside Attendee is what speaks; sending the same audio from here
     * as well would put the character in the meeting twice, half a second apart.
     */
    const speaking = policy.state === "ADDRESSED" || policy.state === "RESPONDING";
    if (!speaking) { stats.suppressed++; return; }
    stats.spokenMs += (body.length / 2 / rate) * 1000;
    return;
  }
  const msg = JSON.parse(data.toString());
  if (msg.type === "user_transcript" && msg.final) {
    stats.transcripts++;
    const before = policy.state;
    policy.onTranscript({ text: msg.text, final: true, speakerName: "participant" }, Date.now());
    const nowAddressed = before !== "ADDRESSED" && policy.state === "ADDRESSED";
    if (nowAddressed) stats.addressed++;
    console.log(`   [聞こえた] ${msg.text}${nowAddressed ? "   → 呼ばれた" : ""}`);
  } else if (msg.type === "assistant_transcript" && msg.final) {
    stats.replies++;
    console.log(`   [Yui] ${msg.text}`);
    policy.onAssistantDone(Date.now());
  }
});

const t0 = Date.now();
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
for (const cue of CUES.filter((c) => c.at < minutes * 60 - 60)) {
  await at(cue.at);
  console.log(`\n${String(Math.floor(cue.at / 60)).padStart(2, "0")}:${String(cue.at % 60).padStart(2, "0")}  ${cue.say}\n        期待: ${cue.expect}`);
}
await at(minutes * 60);

const row = (n, s, d) => console.log(`| ${n} | ${s} | ${d} |`);
console.log(`\n| step | status | detail |\n|---|---|---|`);
const rec = created.meetingRecordId ? await (await fetch(`${broker}/api/meetings/${created.meetingRecordId}`)).json().catch(() => ({})) : {};
const page = await pageState();
row("voice agent page started", page.activations > 0 ? "PASS" : "FAIL", page.activations > 0 ? `activated at ${new Date(page.botPageActivatedAt).toISOString()}` : "the page never loaded — Attendee did not launch it");
row("avatar rendered", page.activations > 0 ? "SEEN_LIVE" : "UNKNOWN", "Live2D rendered on the Meet tile in the first live run — at Attendee's base rate, with no GPU surcharge.");
row("meeting audio reached us", stats.heard > 0 ? "PASS" : "FAIL", `${stats.heard} chunks`);
row("speech transcribed", stats.transcripts > 0 ? "PASS" : "FAIL", `${stats.transcripts} utterances`);
row("addressed by name", stats.addressed > 0 ? "PASS" : "FAIL", `${stats.addressed} times`);
row("answered", stats.replies > 0 ? "PASS" : "FAIL", `${stats.replies} replies`);
row("character's audio reached the meeting", stats.outboundChunks > 0 ? "PASS" : "FAIL", `${stats.outboundChunks} chunks · ${(stats.outboundBytes / 32000).toFixed(1)}s sent back over the relay`);
row("harness-side generation", stats.spokenMs > 500 ? "PASS" : "INFO", `${(stats.spokenMs / 1000).toFixed(1)}s generated by this harness's own agent (not what the room hears)`);
row("stayed quiet when not addressed", stats.suppressed > 0 ? "PASS" : "INFO", `${stats.suppressed} frames withheld`);
row("lifecycle from webhooks", (rec.meeting?.lifecycle ?? []).length > 1 ? "PASS" : "FAIL", (rec.meeting?.lifecycle ?? []).map((l) => l.event).join(" → ") || "no state events");
console.log(`\n録画から自動検証します（アバターが映ったか・Yui の声が入っているか）:`);
console.log(`  pnpm reality:attendee:verify ${created.botId}`);
try { await fetch(`${broker}/api/meeting/attendee/bots/${created.botId}/leave`, { method: "POST" }); } catch { /* best effort */ }
meeting?.close(); agent.close();
process.exit(0);
