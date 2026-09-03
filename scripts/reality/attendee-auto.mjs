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
 *   MEET_URL=... PREFLIGHT_ONLY=1 pnpm reality:attendee:auto     # only the agent check, no bots
 *
 * What a person still has to do: admit both bots (Meet knocks unless the room is open). Everything
 * after that — the cues, the interruption, the scoring, the frames — is this script.
 *
 * Evidence comes from three places that cannot agree by accident:
 *   - the page's own reports (turn / greeting / speaking / spoke / interrupted / fps), via the broker
 *   - the Tester's ears: room audio energy on its relay socket, timed against each cue
 *   - the Tester's recording and transcript afterwards: Yui's tile at 1080p, Yui's utterances by name
 *
 * Before anyone is billed, the agent is asked one text turn over its own socket: runs 11 and 12 were
 * void because the LLM answered 404 and then 400, discovered only after both bots had been admitted.
 *
 * Besides behaviour, each answer is judged as sound: what the Tester heard is compared with what the
 * page sent (a stretch means underruns), scanned for gaps and clipping, and read for a parroted name.
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
/**
 * The room may take a while to let two bots in; nobody is billed for the script until they are. Meet itself
 * gives up a knock after about 10 minutes (「No one responded to your request to join」 → Attendee reports
 * request_to_join_denied, runs 27–28), so a larger value only waits for that verdict: be in the room first.
 */
const admitTimeoutS = Number(process.env.ADMIT_TIMEOUT ?? 300);
/** The Tester's recording: Yui's tile is read from it, so 1080p unless the bot host cannot keep up (self-hosted, emulated). */
const TESTER_RESOLUTION = process.env.TESTER_RESOLUTION ?? "1080p";
/**
 * Yui's own recording is never read here (her tile is not in it). YUI_RECORDING_FORMAT=mp3 drops its screen capture on a
 * bot host that is short of CPU, and 720p shrinks her Chrome window with it (Attendee sizes the window from the recording
 * resolution), so Meet sends that browser smaller tiles to decode.
 */
const YUI_RECORDING = process.env.YUI_RECORDING_FORMAT ? { recording: { format: process.env.YUI_RECORDING_FORMAT, resolution: TESTER_RESOLUTION } } : {};

const platform = detectPlatform(url ?? "");
if (!url || platform === "unknown") { console.log(`BLOCKED_BY_MEET_URL: set MEET_URL to a Google Meet, Zoom or Teams link (got ${url ?? "nothing"})`); process.exit(2); }
if (!env.ATTENDEE_API_KEY) { console.log("BLOCKED_BY_ATTENDEE_KEY"); process.exit(2); }
for (const tool of ["ffmpeg", "say"]) {
  try { execFileSync("which", [tool], { stdio: "pipe" }); } catch { console.log(`BLOCKED_BY_TOOL: ${tool} is not on PATH (the Tester's voice is macOS \`say\` rendered to mp3)`); process.exit(2); }
}

/**
 * One text turn through the running agent — the same process, model, key and request shape the bot
 * page will use. A 404 model, a rejected `reasoning_effort`, an exhausted quota: all of them answer
 * here in a few seconds instead of as silence in a room with two admitted bots.
 */
const PREFLIGHT_S = Number(process.env.PREFLIGHT_TIMEOUT ?? 25);
async function preflightAgent() {
  if (engine !== "local") return { ok: true, note: `engine=${engine}: not routed through services/agent` };
  const agentUrl = process.env.AGENT_URL ?? "ws://127.0.0.1:8788/session";
  return new Promise((resolve) => {
    const t0 = Date.now();
    let sock;
    const done = (r) => { clearTimeout(timer); try { sock?.close(); } catch { /* closing */ } resolve(r); };
    const timer = setTimeout(() => done({ ok: false, error: `no reply from ${agentUrl} in ${PREFLIGHT_S}s` }), PREFLIGHT_S * 1000);
    try { sock = new WebSocket(agentUrl); } catch (err) { return done({ ok: false, error: `${agentUrl}: ${err.message}` }); }
    sock.on("error", (err) => done({ ok: false, error: `${agentUrl}: ${err.message}` }));
    sock.on("open", () => {
      sock.send(JSON.stringify({ type: "start", config: {
        systemPrompt: "あなたは会議に同席しているキャラクターです。日本語で一言だけ答えてください。",
        mode: "free_talk", language: "ja-JP", privacyMode: "default", characterId: process.env.CHARACTER_ID ?? "yui", personaId: "friendly",
      } }));
    });
    sock.on("message", (data, isBinary) => {
      if (isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === "ready") sock.send(JSON.stringify({ type: "text", text: "聞こえてる？一言だけ返して。" }));
      else if (m.type === "assistant_transcript" && m.final) done({ ok: true, text: m.text, ms: Date.now() - t0 });
      else if (m.type === "error") done({ ok: false, error: m.message });
    });
  });
}
const pre = await preflightAgent();
if (!pre.ok) { console.log(`BLOCKED_BY_AGENT_PREFLIGHT: ${pre.error}\n  (the bots were not created; fix the agent — model, key, LOCAL_LLM_REASONING — and run again)`); process.exit(2); }
console.log(pre.text ? `preflight: agent answered in ${pre.ms} ms — ${JSON.stringify(pre.text.slice(0, 60))}` : `preflight: ${pre.note}`);
if (process.env.PREFLIGHT_ONLY) process.exit(0); // `PREFLIGHT_ONLY=1 pnpm reality:attendee:auto`: check the agent, create nothing

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
/**
 * Order matters: the Tester is one participant with two voices, and once it has addressed the
 * character every line of its counts as an engaged follow-up (a person who called the character by
 * name keeps its attention without repeating the name). So the conversation it must stay out of comes
 * first, before anything has engaged it; the addresses follow.
 */
const CUES = [
  { id: "greet", at: 0, kind: "listen", expect: "入室の挨拶をする", window: 25 },
  { id: "chat", at: 25, kind: "conversation", lines: [[VOICE_A, "昨日の資料、見てくれた？"], [VOICE_B, "見たよ。三ページ目の数字が少し気になったかな。"], [VOICE_A, "あそこは後で直しておくね。"], [VOICE_B, "ありがとう、助かる。"]], expect: "割り込まない", window: 30 },
  { id: "ask1", at: 65, kind: "say", voice: VOICE_A, text: "ゆい、今日の予定を教えて。", expect: "答える", window: 15 },
  { id: "third", at: 105, kind: "say", voice: VOICE_A, text: "ゆいが昨日そう言ってたよね。", expect: "答えない", window: 15 },
  { id: "bargein", at: 145, kind: "interrupt", voice: VOICE_A, text: "ゆい、これはどう思う？", cutIn: { voice: VOICE_B, text: "ちょっと待って、その前にこっちの話を先にさせて。" }, expect: "AIが止まる", window: 15 },
  { id: "ask2", at: 190, kind: "say", voice: VOICE_A, text: "ゆい、今どう思う？", expect: "答える", window: 15 },
  { id: "silence", at: 230, kind: "listen", expect: "勝手に話さない", window: 30 },
];
const SCRIPT_END = 270;

// ---- the Tester's voice, rendered before anyone is billed --------------------------------------
const dir = join(tmpdir(), `rcai-auto-${Date.now()}`);
mkdirSync(dir, { recursive: true });
/**
 * `say` starts the voice at 0 ms. A person's mic has been carrying room tone for a while before the first
 * syllable; a stream that begins on 「ゆ」 gives every stage between the Tester and the recogniser (Meet's
 * sender-side processing, the per-participant track opening) a first word to lose — run 46 committed
 * 「今日の予定を教えて。」 for the line 「ゆい、今日の予定を教えて。」 while the same mp3 decodes with the name
 * offline. The clip is led in with this much silence so the onset it tests is a word, not a stream.
 */
const LEAD_IN_MS = 400;
/** @returns {{ mp3: string, seconds: number }} */
function render(voice, text, name) {
  const aiff = join(dir, `${name}.aiff`);
  const mp3 = join(dir, `${name}.mp3`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-af", `adelay=${LEAD_IN_MS}:all=1`, "-ac", "1", "-ar", "24000", "-b:a", "64k", mp3]);
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
    meetingUrl: url, botName, ...YUI_RECORDING,
    botPageQuery: { engine, character: process.env.CHARACTER_ID ?? "yui", name: botName, language: "ja-JP", proactivity, vision: process.env.VISION ?? "cues", ...(process.env.VOICE ? { voice: process.env.VOICE } : {}), ...(process.env.FRAMING ? { framing: process.env.FRAMING } : {}), ...(process.env.YUI_PAGE_FPS ? { fps: process.env.YUI_PAGE_FPS } : {}), outbound: "page" },
  }),
})).json();
if (!yui.botId) { console.log(`FAIL: ${yui.error ?? "join failed"} ${yui.detail ?? ""}`); process.exit(1); }

const tester = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
  method: "POST", headers: { "content-type": "application/json" },
  // The Tester's transcript comes from Meet's own captions unless told otherwise: the self-hosted
  // Attendee has no Deepgram credential, and with one asked for anyway the "room heard the character"
  // row read 0/0 for four admitted runs (44–47) without saying why.
  body: JSON.stringify({ meetingUrl: url, botName: "Tester", role: "listener", botPageQuery: { language: "ja-JP" }, transcription: process.env.TESTER_TRANSCRIPTION ?? "closed_captions", recording: { view: "gallery_view", resolution: TESTER_RESOLUTION } }),
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
const heard = []; // { t: ms since epoch, db, peak (0..1), clipped (samples at full scale), pcm: Int16Array, sr }
let chunks = 0;
/** The Tester's relay. Opened before the bots are admitted, so it may outlive a long knock: say why it closed, and reopen it until the run ends. */
let earsOpen = true;
let ears;
const onEarsMessage = (raw) => {
  try {
    const outer = JSON.parse(String(raw));
    const m = outer.message ?? outer;
    if (m?.trigger !== "realtime_audio.mixed" || !m.data?.chunk) return;
    chunks++;
    const b = Buffer.from(m.data.chunk, "base64");
    const pcm = new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 2)));
    let sum = 0, peak = 0, clipped = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i] / 32768; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; if (a >= 32700 / 32768) clipped++; }
    const rms = Math.sqrt(sum / Math.max(1, pcm.length));
    heard.push({ t: Date.now(), db: 20 * Math.log10(Math.max(1e-6, rms)), peak, clipped, pcm, sr: m.data.sample_rate ?? 16000 });
  } catch { /* ignore */ }
};
const listen = () => {
  ears = new WebSocket(tester.clientWsUrl);
  ears.on("message", onEarsMessage);
  ears.on("error", (err) => console.log(`\n   (Tester relay error: ${err.message})`));
  ears.on("close", (code, reason) => {
    if (!earsOpen) return;
    console.log(`\n   (Tester relay closed ${code} ${String(reason)} after ${chunks} chunks — reopening)`);
    setTimeout(listen, 1000);
  });
};
listen();
const FLOOR_DB = Number(process.env.FLOOR_DB ?? -45);
/** Seconds of audible room audio inside [from, to] (epoch ms), excluding what the Tester itself was saying. */
const audibleSeconds = (from, to, exclude = []) => {
  const pts = heard.filter((h) => h.t >= from && h.t <= to && !exclude.some(([a, b]) => h.t >= a && h.t <= b));
  if (pts.length < 2) return 0;
  const span = (pts[pts.length - 1].t - pts[0].t) / 1000;
  return (pts.filter((h) => h.db > FLOOR_DB).length / pts.length) * span;
};

/**
 * The character as sound, not as behaviour. Everything here is what the Tester heard on its relay,
 * inside a window, with the Tester's own lines excluded:
 *   spanS     first audible chunk to last — against `sentS`, the seconds the page actually sent
 *             (a ratio well over 1 is audio arriving slower than it plays: underruns, silence inserted)
 *   maxGapMs  the longest silence inside the span (a pause at a comma is ~300 ms; a second is a hole)
 *   clipped   samples at full scale, as a share of the audible ones
 *   f99Hz     the frequency below which 99 % of the audible energy sits (speech through a working
 *             path reaches well past 3 kHz; a mangled sample rate or a phone-band path does not)
 */
const audioQuality = (from, to, exclude, sentS) => {
  const pts = heard.filter((h) => h.t >= from && h.t <= to && !exclude.some(([a, b]) => h.t >= a && h.t <= b));
  const loud = pts.map((h, i) => [h.db > FLOOR_DB, i]).filter(([l]) => l).map(([, i]) => i);
  if (loud.length < 2) return null;
  const first = loud[0], last = loud[loud.length - 1];
  const spanS = (pts[last].t - pts[first].t) / 1000;
  let maxGapMs = 0, gapStart = null;
  for (let i = first; i <= last; i++) {
    if (pts[i].db > FLOOR_DB) { if (gapStart != null) { maxGapMs = Math.max(maxGapMs, pts[i].t - gapStart); gapStart = null; } }
    else if (gapStart == null) gapStart = pts[i].t;
  }
  let samples = 0, clipped = 0;
  for (const i of loud) { samples += pts[i].pcm.length; clipped += pts[i].clipped; }
  // Spectrum of the loud chunks (10 ms each on the relay, so they are joined first): 512-point Hann
  // frames, a plain DFT over table lookups — a few hundred frames, well under a second.
  const sr = pts[first].sr;
  const N = 512;
  const MAX_FRAMES = 300;
  const joined = new Float32Array(Math.min(samples, N * MAX_FRAMES));
  let filled = 0;
  for (const i of loud) { const pcm = pts[i].pcm; for (let j = 0; j < pcm.length && filled < joined.length; j++) joined[filled++] = pcm[j] / 32768; }
  const cos = new Float64Array(N), sin = new Float64Array(N), hann = new Float64Array(N);
  for (let n = 0; n < N; n++) { cos[n] = Math.cos((2 * Math.PI * n) / N); sin[n] = Math.sin((2 * Math.PI * n) / N); hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N); }
  const power = new Float64Array(N / 2);
  let frames = 0;
  for (let off = 0; off + N <= filled; off += N, frames++) {
    for (let k = 1; k < N / 2; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) { const x = joined[off + n] * hann[n]; const idx = (k * n) % N; re += x * cos[idx]; im -= x * sin[idx]; }
      power[k] += re * re + im * im;
    }
  }
  let total = 0;
  for (const p of power) total += p;
  let acc = 0, f99Hz = 0;
  for (let k = 0; k < power.length; k++) { acc += power[k]; if (acc >= 0.99 * total) { f99Hz = Math.round((k * sr) / N); break; } }
  const stretch = sentS > 0 ? spanS / sentS : null;
  const issues = [];
  if (stretch != null && stretch > 1.3) issues.push(`stretched ×${stretch.toFixed(2)} (underruns)`);
  if (maxGapMs > 700) issues.push(`gap ${maxGapMs} ms`);
  if (samples && clipped / samples > 0.001) issues.push(`clipping ${(100 * clipped / samples).toFixed(2)}%`);
  if (frames && f99Hz < 2500) issues.push(`muffled f99=${f99Hz} Hz`);
  return { spanS, sentS, stretch, maxGapMs, clipped, samples, f99Hz, sr, issues };
};
const audioLine = (q) => q ? `span=${q.spanS.toFixed(1)}s sent=${q.sentS ? q.sentS.toFixed(1) + "s" : "?"}${q.stretch != null ? ` ×${q.stretch.toFixed(2)}` : ""} gap=${q.maxGapMs}ms clip=${q.clipped}/${q.samples} f99=${q.f99Hz}Hz@${q.sr}` : "nothing audible";
/** The reply must not open with the name the recogniser wrote (「ゆイ、お疲れ様！」, run 15) — nor the real one. */
const NAME_ECHO = new RegExp(`^\\s*(?:${[botName, "ゆい", "ゆイ", "ユイ", "うい", "yui"].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*(?:さん|ちゃん)?\\s*[、,!！?？…\\s]`, "i");

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
const audio = []; // per answered cue: { id, quality, reply, echo }
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
    case "greet": {
      // Yui greets on admission, and admission is per bot: when she is let in first, the greeting is
      // over before the Tester (and T0) exists. Run 14 greeted at T0−26 s, 174 frames spoken by T0−18 s,
      // and scored 0 against the window. The greeting is judged from its own event, not from T0.
      const greeting = eventsBetween(ev, T0 - 60_000, end, "greeting");
      const gAt = greeting[0]?.at ?? start;
      const spokeAfter = eventsBetween(ev, gAt, end, "speaking").length;
      const frames = eventsBetween(ev, gAt, end, "spoke").reduce((n, e) => Math.max(n, e.data?.frames ?? 0), 0);
      status = greeting.length && (spokeAfter || heardS > 0.5) ? "PASS" : "FAIL";
      detail = `greeting=${greeting.map((e) => `${JSON.stringify(e.data)}@${((e.at - T0) / 1000).toFixed(1)}s`).join(",") || "none"} speaking=${spokeAfter} spoke=${frames}f heard=${heardS.toFixed(1)}s${gAt < start ? " (before the Tester joined: not audible to it)" : ""}`;
      break;
    }
    case "ask1": case "ask2": {
      status = turns.length && speaking.length && heardS > 0.5 ? "PASS" : turns.length ? "PARTIAL" : "FAIL";
      detail = `turn=${turns.map((e) => e.data.reason).join(",") || "none"} speaking=${speaking.length} heard=${heardS.toFixed(1)}s`;
      const spoke = eventsBetween(ev, start, end, "spoke");
      const reply = spoke.map((e) => e.data?.text ?? "").join(" / ");
      const sentS = spoke.reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
      const q = audioQuality(start, end, spoken, sentS);
      const echo = reply ? NAME_ECHO.test(reply) : false;
      audio.push({ id: cue.id, quality: q, reply, echo, start, end });
      detail += ` · reply=${JSON.stringify(reply.slice(0, 60))}${echo ? " NAME-ECHO" : ""} · audio: ${audioLine(q)}${q?.issues.length ? ` ⚠ ${q.issues.join(", ")}` : ""}`;
      break;
    }
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
earsOpen = false;
ears.close();
const beat = finalPage.pageHeartbeat?.data ?? {};
// `spoke` is logged when the page finishes playing, which is often after the cue's window has closed
// (run 47: ask1 answered inside the window, `spoke` at 81.2 s against a window ending at 80 s — read
// as `reply=""`, and the parrot check came out UNKNOWN on a run with two perfectly good answers). The
// final page state has it; an answer that began in the window is that cue's, wherever it ended.
for (const a of audio) {
  if (a.reply) continue;
  const late = eventsBetween(finalPage.pageEvents ?? [], a.start, a.end + 20_000, "spoke");
  if (!late.length) continue;
  a.reply = late.map((e) => e.data?.text ?? "").join(" / ");
  a.echo = NAME_ECHO.test(a.reply);
  const sentS = late.reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
  a.quality = audioQuality(a.start, a.end, spoken, sentS) ?? a.quality;
  const r = results.find((x) => x.id === a.id);
  if (r) r.detail = r.detail.replace('reply=""', `reply=${JSON.stringify(a.reply.slice(0, 60))}${a.echo ? " NAME-ECHO" : ""} (spoke after the window)`);
}
console.log(`\n| step | status | detail |\n|---|---|---|`);
const row = (n, s, d) => console.log(`| ${n} | ${s} | ${d} |`);
row("voice agent page started", finalPage.activations > 0 ? "PASS" : "FAIL", finalPage.activations > 0 ? `activated at ${new Date(finalPage.botPageActivatedAt).toISOString()}` : "the page never loaded");
row("page render rate", beat.fps == null ? "UNKNOWN" : beat.fps >= 20 ? "PASS" : "LOW", `${beat.fps ?? "?"} fps at the last heartbeat · avatar=${beat.avatar ?? "?"}`);
row("tester heard the room", chunks > 0 ? "PASS" : "FAIL", `${chunks} chunks on the Tester's relay`);
for (const r of results) row(r.id, r.status, `${r.expect} · ${r.detail}`);
const judged = audio.filter((a) => a.quality);
const degraded = judged.filter((a) => a.quality.issues.length);
row("answers as sound", !judged.length ? "UNKNOWN" : degraded.length ? "DEGRADED" : "PASS", judged.length ? judged.map((a) => `${a.id}: ${audioLine(a.quality)}${a.quality.issues.length ? ` ⚠ ${a.quality.issues.join(", ")}` : ""}`).join(" · ") : "no answer was audible to the Tester");
const echoed = audio.filter((a) => a.echo);
row("reply does not parrot the name", !audio.some((a) => a.reply) ? "UNKNOWN" : echoed.length ? "FAIL" : "PASS", echoed.length ? echoed.map((a) => `${a.id}: ${JSON.stringify(a.reply.slice(0, 40))}`).join(" · ") : `${audio.filter((a) => a.reply).length} replies read`);

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
  writeFileSync(join(dir, "report.json"), JSON.stringify({ meetingUrl: url, yui: yui.botId, tester: tester.botId, engine, proactivity, T0, results, audio: audio.map((a) => ({ ...a, quality: a.quality && { ...a.quality } })), preflight: pre, heartbeat: beat, pageEvents: finalPage.pageEvents, transcript: utt, recording: rec }, null, 2));
  console.log(`\nreport → ${join(dir, "report.json")}`);
} else {
  row("tester recording", "FAIL", "no recording from the Tester");
}
process.exit(0);
