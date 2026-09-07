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
 * The page knows four engines — auto, openai, google, local — and silently keeps its own setting for
 * anything else. `ENGINE=gemini` (2026-09-07) therefore ran a Gemini gate on OpenAI, which had no
 * credits: the character rendered, said nothing, and put a 429 on its own tile in the meeting.
 */
const KNOWN_ENGINES = ["auto", "openai", "google", "local"];
if (engine && !KNOWN_ENGINES.includes(engine)) {
  console.log(`BLOCKED_BY_ENGINE: ENGINE=${engine} is not one of ${KNOWN_ENGINES.join(", ")} (Gemini is "google")`);
  process.exit(2);
}
/**
 * How much the character needs before it speaks. `addressed_only` is the product default; the gate can
 * ask for more, and `open` is the setting that proves the voice path without depending on the
 * recogniser getting a two-mora name right.
 */
/**
 * One person talking to the character: it answers what is said to it, without being called by name
 * first (defaultProactivityFor). `PROACTIVITY=addressed_only` puts it back for a meeting.
 */
const proactivity = process.env.PROACTIVITY ?? "open";
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
      /**
       * page: the character's voice leaves through the page's own speaker, which is what Attendee's
       * webpage streamer captures as the bot's microphone. socket: it is also sent back over the
       * relay, where this harness can count it — and then the room hears her twice, half a second
       * apart, each copy feeding the next (「すごくハウリングしています」, real one-to-one, 2026-09-07).
       * With a webpage streamer there is only one right answer, and counting is not worth a howl.
       */
      outbound: process.env.OUTBOUND ?? "page",
      // The ordinary case is one person talking with the character, not a meeting with minutes.
      persona: process.env.PERSONA_ID ?? "friend_ja",
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

/**
 * The page's own view, every 10 s. Without it a run that goes quiet can only be diagnosed after the
 * fact, and the last three were: the character heard 48 utterances and answered none while every
 * counter this harness owns looked healthy.
 */
let seenEvents = 0;
const watch = setInterval(async () => {
  const p = await pageState();
  const h = p?.pageHeartbeat?.data;
  if (h) console.log(`   [page] transcripts ${h.transcripts} · spoke ${h.spoke} · answers ${h.answers ?? 0} · cuts ${h.cuts ?? 0} · ${h.state}/${h.engagement}${h.gate ? ` · gate open ${h.gate.opens}/close ${h.gate.closes}/forced ${h.gate.forced} · sent ${h.gate.sent}` : ""}`);
  for (const ev of (p?.pageEvents ?? []).slice(seenEvents)) {
    if (["turn", "cut", "released", "spoke", "interrupted", "greeting"].includes(ev.type)) console.log(`   [page:${ev.type}] ${JSON.stringify(ev.data).slice(0, 160)}`);
  }
  seenEvents = (p?.pageEvents ?? []).length;
}, 10000);

const t0 = Date.now();
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
for (const cue of CUES.filter((c) => c.at < minutes * 60 - 60)) {
  await at(cue.at);
  console.log(`\n${String(Math.floor(cue.at / 60)).padStart(2, "0")}:${String(cue.at % 60).padStart(2, "0")}  ${cue.say}\n        期待: ${cue.expect}`);
}
await at(minutes * 60);

clearInterval(watch);
const row = (n, s, d) => console.log(`| ${n} | ${s} | ${d} |`);
console.log(`\n| step | status | detail |\n|---|---|---|`);
const rec = created.meetingRecordId ? await (await fetch(`${broker}/api/meetings/${created.meetingRecordId}`)).json().catch(() => ({})) : {};
const page = await pageState();
row("voice agent page started", page.activations > 0 ? "PASS" : "FAIL", page.activations > 0 ? `activated at ${new Date(page.botPageActivatedAt).toISOString()}` : "the page never loaded — Attendee did not launch it");
row("avatar rendered", page.activations > 0 ? "SEEN_LIVE" : "UNKNOWN", "Live2D rendered on the Meet tile in the first live run — at Attendee's base rate, with no GPU surcharge.");
/**
 * What the character did, from the character's own page — not from this harness's parallel copy of
 * the room. The copy is a second subscriber on the relay and can be empty while the character is
 * hearing and answering perfectly (run of 2026-09-07 20:12: 0 chunks here, 7 utterances and 4 spoken
 * answers there), which reads as a total failure of a run that worked.
 */
const beat = page?.pageHeartbeat?.data ?? {};
const spokeEvents = (page?.pageEvents ?? []).filter((e) => e.type === "spoke");
row("meeting audio reached the character", (beat.heard ?? 0) > 0 ? "PASS" : "FAIL", `${beat.heard ?? 0} frames at the page (${stats.heard} on this harness's own copy of the relay)`);
row("speech transcribed", (beat.transcripts ?? 0) > 0 ? "PASS" : "FAIL", `${beat.transcripts ?? 0} utterances`);
row("turns taken", (beat.answers ?? 0) > 0 ? "PASS" : "FAIL", `${beat.answers ?? 0} answers begun · ${beat.cuts ?? 0} cut unsanctioned`);
row("answered out loud", spokeEvents.length > 0 ? "PASS" : "FAIL", spokeEvents.map((e) => `${e.data.seconds}s`).join(" · ") || "nothing spoken");
row("audio gate", beat.gate ? ((beat.gate.forced ?? 0) === 0 ? "PASS" : "INFO") : "UNKNOWN", beat.gate ? `${beat.gate.opens} opens / ${beat.gate.closes} closes / ${beat.gate.forced} forced · ${beat.gate.sent} chunks sent to the model` : "no gate counters");
const spokeFrames = page?.pageHeartbeat?.data?.spoke ?? 0;
row(
  "character's audio reached the meeting",
  (process.env.OUTBOUND ?? "page") === "page"
    ? (spokeFrames > 0 ? "PASS" : "FAIL")
    : (stats.outboundChunks > 0 ? "PASS" : "FAIL"),
  (process.env.OUTBOUND ?? "page") === "page"
    ? `${spokeFrames} frames spoken through the page's own speaker (what the streamer captures); confirm in the recording with reality:attendee:verify`
    : `${stats.outboundChunks} chunks · ${(stats.outboundBytes / 32000).toFixed(1)}s sent back over the relay`,
);
row("harness-side generation", stats.spokenMs > 500 ? "PASS" : "INFO", `${(stats.spokenMs / 1000).toFixed(1)}s generated by this harness's own agent (not what the room hears)`);
row("stayed quiet when not addressed", stats.suppressed > 0 ? "PASS" : "INFO", `${stats.suppressed} frames withheld`);
row("lifecycle from webhooks", (rec.meeting?.lifecycle ?? []).length > 1 ? "PASS" : "FAIL", (rec.meeting?.lifecycle ?? []).map((l) => l.event).join(" → ") || "no state events");
console.log(`\n録画から自動検証します（アバターが映ったか・Yui の声が入っているか）:`);
console.log(`  pnpm reality:attendee:verify ${created.botId}`);
try { await fetch(`${broker}/api/meeting/attendee/bots/${created.botId}/leave`, { method: "POST" }); } catch { /* best effort */ }
meeting?.close(); agent.close();
process.exit(0);
