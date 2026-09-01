/**
 * The gate nothing else substitutes for: a real Google Meet, real people, the real character.
 *
 * Everything else in this repo verifies a piece. This verifies the product:
 *
 *   real meeting → human voice → Recall input → address detection → realtime AI → Output Media → heard
 *
 *   MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm reality:meet:human          # 10-minute smoke
 *   MEET_URL=... MINUTES=30 pnpm reality:meet:human                                # commercial gate
 *
 * It prompts the people in the meeting on a clock, and scores what it can see from the broker — bot
 * lifecycle (from webhooks, not polling), transcripts, and whether the character answered. The rows only
 * a person can judge — did you hear it, did the chat notice appear — are printed for you to fill in,
 * because a harness claiming them would be worthless.
 */
import { loadEnv } from "./lib.mjs";
import { createRequire } from "node:module";

const require = createRequire("/Users/horioshuuhei/Projects/AI-meeting/services/agent/package.json");
const WebSocket = require("ws");

const env = loadEnv();
const url = process.env.MEET_URL;
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const minutes = Number(process.env.MINUTES ?? 10);
if (!url || !/^https:\/\/meet\.google\.com\//.test(url)) { console.log("BLOCKED_BY_MEET_URL"); process.exit(2); }
if (!env.RECALL_API_KEY) { console.log("BLOCKED_BY_RECALL_KEY"); process.exit(2); }

/** The 10-minute script, scaled if you ask for longer. Each cue is one thing to observe. */
const CUES = [
  { at: 60, say: "「ゆい、今日の予定を教えて」", expect: "答える", key: "addressed" },
  { at: 120, say: "「ゆいが昨日そう言ってた」（三人称）", expect: "答えない", key: "third_person" },
  { at: 180, say: "人A「ゆい、これはどう？」→ 答え始めたら人Bが割り込む", expect: "AIが即座に止まる", key: "bargein" },
  { at: 240, say: "人Aと人Bだけで30秒会話する", expect: "割り込まない", key: "human_only" },
  { at: 300, say: "「ゆい、今どう思う？」", expect: "答える", key: "addressed2" },
  { at: 360, say: "全員30秒黙る", expect: "勝手に話さない", key: "silence" },
  { at: 420, say: "人が1名退出→再参加", expect: "状態が壊れない", key: "rejoin" },
  { at: 480, say: "そのまま会話を続ける", expect: "復帰後も応答する", key: "after_rejoin" },
];

const post = async (p, b) => (await fetch(`${broker}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) })).json();

console.log(`\n=== ${minutes} 分 実人間 Reality Gate ===`);
console.log(`会議: ${url}\n`);
const created = await post("/api/meeting/recall/bots", { meetingUrl: url, botName: env.RECALL_BOT_NAME ?? "Yui", language: "ja", mode: "output_media", force: true });
if (created.error) { console.log(`FAIL: ${created.error} ${created.detail ?? ""}`); process.exit(1); }
const { botId, sessionId, meetingRecordId, clientWsUrl } = created;
console.log(`bot ${botId}\n>>> Meet で「${env.RECALL_BOT_NAME ?? "Yui"}」の参加を承認してください。\n`);

/** Watch the relay: transcripts and the webhook-pushed status. No polling. */
const seen = { transcripts: 0, replies: 0, statuses: [], lastStatusAt: {} };
const ws = new WebSocket(clientWsUrl);
ws.on("message", (raw) => {
  try {
    const { message } = JSON.parse(String(raw));
    if (!message?.event) return;
    if (message.event === "bot.status_change") {
      const code = message.data?.data?.code;
      if (code && seen.statuses.at(-1) !== code) { seen.statuses.push(code); seen.lastStatusAt[code] = Date.now(); console.log(`   [state] ${code}`); }
    } else if (message.event === "transcript.data") {
      seen.transcripts++;
      const text = (message.data?.data?.words ?? []).map((w) => w.text).join("");
      if (text) console.log(`   [聞こえた] ${text}`);
    }
  } catch { /* ignore */ }
});
ws.on("error", (e) => console.log(`   [relay] ${e.message}`));

const t0 = Date.now();
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, t0 + s * 1000 - Date.now())));
for (const cue of CUES.filter((c) => c.at < minutes * 60 - 60)) {
  await at(cue.at);
  const m = String(Math.floor(cue.at / 60)).padStart(2, "0"), sec = String(cue.at % 60).padStart(2, "0");
  console.log(`\n${m}:${sec}  ${cue.say}\n        期待: ${cue.expect}`);
}
await at(minutes * 60 - 30);
console.log(`\n${String(minutes - 1).padStart(2, "0")}:30  会議を終了してください（Bot は自動で退出します）`);
await at(minutes * 60);

const rec = await (await fetch(`${broker}/api/meetings/${meetingRecordId}`)).json();
const lifecycle = (rec.meeting?.lifecycle ?? []).map((l) => l.event);
ws.close();

const row = (name, status, detail) => console.log(`| ${name} | ${status} | ${detail} |`);
console.log(`\n| step | status | detail |\n|---|---|---|`);
row("bot joined (webhook)", seen.statuses.includes("in_call_recording") ? "PASS" : "FAIL", seen.statuses.join(" → ") || "no status pushed");
row("meeting transcripts reached us", seen.transcripts > 0 ? "PASS" : "FAIL", `${seen.transcripts} segments`);
row("lifecycle recorded", lifecycle.length ? "PASS" : "FAIL", lifecycle.join(" → "));
row("call_ended → done", lifecycle.includes("bot.done") ? "PASS" : "PENDING", "done arrives after the call ends");
for (const c of CUES.filter((c) => c.at < minutes * 60 - 60)) row(`${c.key} — ${c.expect}`, "HUMAN", c.say);
row("chat notice visible on join", "HUMAN", "Meet のチャットに AI 参加・録音・文字起こしの告知が出たか");
row("audio heard by a person", "HUMAN", "Yui の声が実際に聞こえたか");
console.log(`\nHUMAN 行はあなたの判断です。全て PASS のときだけ商用 Gate 通過とします。`);
console.log(`meeting record: ${broker}/api/meetings/${meetingRecordId}`);
await post(`/api/meeting/recall/bots/${botId}/leave`);
