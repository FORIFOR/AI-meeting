/**
 * The real-meeting gate with no person in the loop: two bots in one meeting.
 *
 *   Yui      the product — the avatar page as an Attendee voice agent, exactly as a customer gets it
 *   Tester   a second Attendee bot with no page: it speaks the cue script into the room through its own
 *            microphone, hears the room (and Yui in it) on its relay socket, and records what the room
 *            sees — including Yui's tile, which Yui's own recording never contains
 *
 *   MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm reality:attendee:auto
 *   MEET_URL=... ENGINE=local PROACTIVITY=addressed_only pnpm reality:attendee:auto
 *
 * What a person still has to do: admit both bots (Meet knocks unless the room is open). Everything
 * after that — the cues, the interruption, the scoring, the frames — is this script.
 *
 * Evidence comes from three places that cannot agree by accident:
 *   - the page's own reports (turn / greeting / speaking / spoke / interrupted / fps), via the broker
 *   - the Tester's ears: room audio energy on its relay socket, timed against each cue
 *   - the Tester's recording and transcript afterwards: Yui's tile at 1080p, Yui's utterances by name
 */
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, sleep } from "./lib.mjs";
import { detectPlatform } from "../../packages/meeting-core/src/index.js";

const require = createRequire("/Users/horioshuuhei/Projects/AI-meeting/services/agent/package.json");
const WebSocket = require("ws");

const env = loadEnv();
const url = process.env.MEET_URL;
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const attendee = env.ATTENDEE_API_BASE_URL ?? "https://app.attendee.dev";
const engine = process.env.ENGINE ?? "local";
const proactivity = process.env.PROACTIVITY ?? "addressed_only";
const botName = env.RECALL_BOT_NAME ?? "Yui";
/** The room may take a while to let two bots in; nobody is billed for the script until they are. */
const admitTimeoutS = Number(process.env.ADMIT_TIMEOUT ?? 300);

const platform = detectPlatform(url ?? "");
if (!url || platform === "unknown") { console.log(`BLOCKED_BY_MEET_URL: set MEET_URL to a Google Meet, Zoom or Teams link (got ${url ?? "nothing"})`); process.exit(2); }
if (!env.ATTENDEE_API_KEY) { console.log("BLOCKED_BY_ATTENDEE_KEY"); process.exit(2); }
for (const tool of ["ffmpeg", "say"]) {
  try { execFileSync("which", [tool], { stdio: "pipe" }); } catch { console.log(`BLOCKED_BY_TOOL: ${tool} is not on PATH (the Tester's voice is macOS \`say\` rendered to mp3)`); process.exit(2); }
}

const api = async (path, init = {}) => {
  const r = await fetch(`${attendee}/api/v1/bots${path}`, { ...init, headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
};

// ---- the script ---------------------------------------------------------------------------------
/**
 * Two voices so "someone else cut in" is audibly someone else. Both are the OS's; the point is not
 * naturalness but that the recogniser hears a name and the policy hears a second speaker.
 */
const VOICE_A = process.env.VOICE_A ?? "Kyoko";
const VOICE_B = process.env.VOICE_B ?? "Eddy";
const CUES = [
  { id: "greet", at: 0, kind: "listen", expect: "入室の挨拶をする", window: 25 },
  { id: "ask1", at: 25, kind: "say", voice: VOICE_A, text: "ゆい、今日の予定を教えて。", expect: "答える", window: 15 },
  { id: "third", at: 65, kind: "say", voice: VOICE_A, text: "ゆいが昨日そう言ってたよね。", expect: "答えない", window: 15 },
  { id: "bargein", at: 105, kind: "interrupt", voice: VOICE_A, text: "ゆい、これはどう思う？", cutIn: { voice: VOICE_B, text: "ちょっと待って、その前にこっちの話を先にさせて。" }, expect: "AIが止まる", window: 15 },
  { id: "chat", at: 150, kind: "conversation", lines: [[VOICE_A, "昨日の資料、見てくれた？"], [VOICE_B, "見たよ。三ページ目の数字が少し気になったかな。"], [VOICE_A, "あそこは後で直しておくね。"], [VOICE_B, "ありがとう、助かる。"]], expect: "割り込まない", window: 30 },
  { id: "ask2", at: 200, kind: "say", voice: VOICE_A, text: "ゆい、今どう思う？", expect: "答える", window: 15 },
  { id: "silence", at: 240, kind: "listen", expect: "勝手に話さない", window: 30 },
];
const SCRIPT_END = 280;

// ---- the Tester's voice, rendered before anyone is billed --------------------------------------
const dir = join(tmpdir(), `rcai-auto-${Date.now()}`);
mkdirSync(dir, { recursive: true });
/** @returns {{ mp3: string, seconds: number }} */
function render(voice, text, name) {
  const aiff = join(dir, `${name}.aiff`);
  const mp3 = join(dir, `${name}.mp3`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-ac", "1", "-ar", "24000", "-b:a", "64k", mp3]);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp3]).toString().trim());
  return { mp3: readFileSync(mp3).toString("base64"), seconds };
}
const clips = new Map();
for (const c of CUES) {
  if (c.kind === "say" || c.kind === "interrupt") clips.set(c.id, render(c.voice, c.text, c.id));
  if (c.kind === "interrupt") clips.set(`${c.id}:cut`, render(c.cutIn.voice, c.cutIn.text, `${c.id}-cut`));
  if (c.kind === "conversation") c.lines.forEach(([v, t], i) => clips.set(`${c.id}:${i}`, render(v, t, `${c.id}-${i}`)));
}
console.log(`rendered ${clips.size} clips → ${dir}`);

// ---- two bots -----------------------------------------------------------------------------------
const yui = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    meetingUrl: url, botName,
    botPageQuery: { engine, character: process.env.CHARACTER_ID ?? "yui", name: botName, language: "ja-JP", proactivity, vision: process.env.VISION ?? "cues", ...(process.env.VOICE ? { voice: process.env.VOICE } : {}), outbound: "page" },
  }),
})).json();
if (!yui.botId) { console.log(`FAIL: ${yui.error ?? "join failed"} ${yui.detail ?? ""}`); process.exit(1); }

const tester = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ meetingUrl: url, botName: "Tester", role: "listener", botPageQuery: { language: "ja-JP" }, recording: { view: "gallery_view", resolution: "1080p" } }),
})).json();
if (!tester.botId) {
  console.log(`FAIL: tester ${tester.error ?? "join failed"} ${tester.detail ?? ""}`);
  await fetch(`${broker}/api/meeting/attendee/bots/${yui.botId}/leave`, { method: "POST" }).catch(() => {});
  process.exit(1);
}
console.log(`\n=== 自動 実会議 Gate (Attendee × 2) ===\n${botName} ${yui.botId}  Tester ${tester.botId}  engine=${engine}  proactivity=${proactivity}  platform=${platform}`);
console.log(`>>> Meet で「${botName}」と「Tester」の参加を承認してください（${admitTimeoutS}s 以内）。\n`);

const leaveAll = async () => {
  for (const id of [yui.botId, tester.botId]) await fetch(`${broker}/api/meeting/attendee/bots/${id}/leave`, { method: "POST" }).catch(() => {});
};
process.on("SIGINT", () => { void leaveAll().then(() => process.exit(130)); });

// ---- the Tester's ears --------------------------------------------------------------------------
/** Room audio, as energy over time. A window is "heard" when enough of it is above the floor. */
const heard = []; // { t: ms since epoch, db }
let chunks = 0;
const ears = new WebSocket(tester.clientWsUrl);
ears.on("message", (raw) => {
  try {
    const outer = JSON.parse(String(raw));
    const m = outer.message ?? outer;
    if (m?.trigger !== "realtime_audio.mixed" || !m.data?.chunk) return;
    chunks++;
    const b = Buffer.from(m.data.chunk, "base64");
    let sum = 0;
    for (let i = 0; i + 1 < b.length; i += 2) { const v = b.readInt16LE(i) / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / Math.max(1, b.length / 2));
    heard.push({ t: Date.now(), db: 20 * Math.log10(Math.max(1e-6, rms)) });
  } catch { /* ignore */ }
});
const FLOOR_DB = Number(process.env.FLOOR_DB ?? -45);
/** Seconds of audible room audio inside [from, to] (epoch ms), excluding what the Tester itself was saying. */
const audibleSeconds = (from, to, exclude = []) => {
  const pts = heard.filter((h) => h.t >= from && h.t <= to && !exclude.some(([a, b]) => h.t >= a && h.t <= b));
  if (pts.length < 2) return 0;
  const span = (pts[pts.length - 1].t - pts[0].t) / 1000;
  return (pts.filter((h) => h.db > FLOOR_DB).length / pts.length) * span;
};

// ---- wait for both to be in the call ------------------------------------------------------------
const IN_CALL = new Set(["joined_recording", "joined_not_recording", "joined_recording_paused"]);
const state = async (id) => (await api(`/${id}`)).body?.state ?? "?";
const t0 = Date.now();
let joined = false;
while (Date.now() - t0 < admitTimeoutS * 1000) {
  const [a, b] = await Promise.all([state(yui.botId), state(tester.botId)]);
  process.stdout.write(`\r   ${botName}=${a}  Tester=${b}  (${Math.round((Date.now() - t0) / 1000)}s)   `);
  if (["fatal_error", "ended"].includes(a) || ["fatal_error", "ended"].includes(b)) break;
  if (IN_CALL.has(a) && IN_CALL.has(b)) { joined = true; break; }
  await sleep(3000);
}
console.log("");
if (!joined) { console.log("FAIL: both bots were not admitted in time"); await leaveAll(); process.exit(1); }
const T0 = Date.now();
console.log(`両方入室 (${Math.round((T0 - t0) / 1000)}s)。スクリプト開始。\n`);

// ---- page reports, from the broker ---------------------------------------------------------------
const pageState = async () => {
  try { return await (await fetch(`${broker}/api/meeting/session/${yui.sessionId}`, { headers: { authorization: `Bearer ${yui.clientToken}` } })).json(); } catch { return {}; }
};
const eventsBetween = (events, from, to, type) => events.filter((e) => e.at >= from && e.at <= to && (!type || e.type === type));

// ---- speak into the room ------------------------------------------------------------------------
const spoken = []; // [from, to] epoch ms windows where the Tester itself was talking
async function speak(key) {
  const clip = clips.get(key);
  const from = Date.now();
  const r = await api(`/${tester.botId}/output_audio`, { method: "POST", body: JSON.stringify({ type: "audio/mp3", data: clip.mp3 }) });
  if (!r.ok) console.log(`   [tester] output_audio failed ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  await sleep(clip.seconds * 1000 + 400);
  spoken.push([from, Date.now()]);
  return { from, to: Date.now() };
}
const at = (s) => new Promise((r) => setTimeout(r, Math.max(0, T0 + s * 1000 - Date.now())));
const stamp = (ms) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

const results = [];
for (const cue of CUES) {
  await at(cue.at);
  const start = Date.now();
  console.log(`${stamp(start - T0)}  [${cue.id}] ${cue.text ?? cue.kind}\n        期待: ${cue.expect}`);
  let cutAt = null;
  if (cue.kind === "say") await speak(cue.id);
  else if (cue.kind === "conversation") for (let i = 0; i < cue.lines.length; i++) { await speak(`${cue.id}:${i}`); await sleep(1200); }
  else if (cue.kind === "interrupt") {
    await speak(cue.id);
    // Cut in the moment Yui starts, or after a grace period if she never does.
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const st = await pageState();
      if (eventsBetween(st.pageEvents ?? [], start, Date.now(), "speaking").length) break;
      await sleep(250);
    }
    cutAt = Date.now();
    await speak(`${cue.id}:cut`);
  }
  const end = start + cue.window * 1000;
  await at((end - T0) / 1000);
  const st = await pageState();
  const ev = st.pageEvents ?? [];
  const turns = eventsBetween(ev, start, end, "turn");
  const speaking = eventsBetween(ev, start, end, "speaking");
  const interrupted = eventsBetween(ev, start, end, "interrupted");
  const heardS = audibleSeconds(start, end, spoken);
  let status;
  let detail;
  switch (cue.id) {
    case "greet": status = eventsBetween(ev, T0 - 60_000, end, "greeting").length && (speaking.length || heardS > 0.5) ? "PASS" : "FAIL"; detail = `greeting=${eventsBetween(ev, T0 - 60_000, end, "greeting").map((e) => JSON.stringify(e.data)).join(",") || "none"} speaking=${speaking.length} heard=${heardS.toFixed(1)}s`; break;
    case "ask1": case "ask2": status = turns.length && speaking.length && heardS > 0.5 ? "PASS" : turns.length ? "PARTIAL" : "FAIL"; detail = `turn=${turns.map((e) => e.data.reason).join(",") || "none"} speaking=${speaking.length} heard=${heardS.toFixed(1)}s`; break;
    case "third": case "chat": case "silence": status = !turns.length && !speaking.length ? "PASS" : "FAIL"; detail = `turn=${turns.length} speaking=${speaking.length} heard=${heardS.toFixed(1)}s`; break;
    case "bargein": {
      const afterCut = cutAt ? audibleSeconds(cutAt + 1500, cutAt + 5000, spoken) : 0;
      status = speaking.length && interrupted.length && afterCut < 0.5 ? "PASS" : speaking.length ? "PARTIAL" : "FAIL";
      detail = `speaking=${speaking.length} interrupted=${interrupted.length} audible 1.5–5s after the cut-in=${afterCut.toFixed(1)}s`;
      break;
    }
    default: status = "INFO"; detail = "";
  }
  results.push({ id: cue.id, expect: cue.expect, status, detail });
  console.log(`        → ${status}  ${detail}\n`);
}
await at(SCRIPT_END);

// ---- leave, then read the Tester's recording ------------------------------------------------------
const finalPage = await pageState();
await leaveAll();
ears.close();
const beat = finalPage.pageHeartbeat?.data ?? {};
console.log(`\n| step | status | detail |\n|---|---|---|`);
const row = (n, s, d) => console.log(`| ${n} | ${s} | ${d} |`);
row("voice agent page started", finalPage.activations > 0 ? "PASS" : "FAIL", finalPage.activations > 0 ? `activated at ${new Date(finalPage.botPageActivatedAt).toISOString()}` : "the page never loaded");
row("page render rate", beat.fps == null ? "UNKNOWN" : beat.fps >= 20 ? "PASS" : "LOW", `${beat.fps ?? "?"} fps at the last heartbeat · avatar=${beat.avatar ?? "?"}`);
row("tester heard the room", chunks > 0 ? "PASS" : "FAIL", `${chunks} chunks on the Tester's relay`);
for (const r of results) row(r.id, r.status, `${r.expect} · ${r.detail}`);

console.log(`\nTester の録画を待っています（${botName} のタイルと声が入っているはず）…`);
let rec = null;
for (let i = 0; i < 60; i++) {
  const b = (await api(`/${tester.botId}`)).body;
  if (b?.state === "ended" && b?.recording_state === "complete") { rec = (await api(`/${tester.botId}/recording`)).body; break; }
  if (b?.state === "fatal_error") break;
  await sleep(5000);
}
if (rec?.url) {
  const mp4 = join(dir, "tester.mp4");
  writeFileSync(mp4, Buffer.from(await (await fetch(rec.url)).arrayBuffer()));
  const framesDir = join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  // One frame per cue, at the moment an answer was expected: what the room saw of the character.
  const recStart = rec.start_timestamp_ms ?? T0;
  for (const cue of CUES) {
    const sec = Math.max(0, (T0 + (cue.at + 8) * 1000 - recStart) / 1000);
    try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(sec), "-i", mp4, "-frames:v", "1", join(framesDir, `${cue.id}.png`)]); } catch { /* past the end */ }
  }
  const tr = (await api(`/${tester.botId}/transcript`)).body;
  const utt = Array.isArray(tr) ? tr : (tr?.results ?? []);
  const byYui = utt.filter((u) => (u.speaker_name ?? "") === botName);
  row("tester recording", "PASS", `${mp4} · frames → ${framesDir}`);
  row("room heard the character (vendor transcript)", byYui.length ? "PASS" : "FAIL", `${byYui.length}/${utt.length} utterances by ${botName}: ${byYui.slice(0, 3).map((u) => JSON.stringify(u.transcription?.transcript ?? u.transcription).slice(0, 60)).join(" / ")}`);
  writeFileSync(join(dir, "report.json"), JSON.stringify({ meetingUrl: url, yui: yui.botId, tester: tester.botId, engine, proactivity, T0, results, heartbeat: beat, pageEvents: finalPage.pageEvents, transcript: utt, recording: rec }, null, 2));
  console.log(`\nreport → ${join(dir, "report.json")}`);
} else {
  row("tester recording", "FAIL", "no recording from the Tester");
}
process.exit(0);
