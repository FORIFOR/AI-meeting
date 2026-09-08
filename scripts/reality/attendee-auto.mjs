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
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, sleep } from "./lib.mjs";
import { oneToOneCues } from "./scenarios/one-to-one.mjs";
import { detectPlatform } from "../../packages/meeting-core/src/index.js";

const require = createRequire("/Users/horioshuuhei/Projects/AI-meeting/services/agent/package.json");
const WebSocket = require("ws");

const env = loadEnv();
const url = process.env.MEET_URL;
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const attendee = env.ATTENDEE_API_BASE_URL ?? "https://app.attendee.dev";
const engine = process.env.ENGINE ?? "local";
/**
 * A meeting waits to be called; a one-to-one does not. The scenario decides, so the script and the
 * character's own rules cannot disagree — a room script run against an always-answering character
 * fails every cue that asks it to stay out of a conversation.
 */
const proactivity = process.env.PROACTIVITY ?? ((process.env.SCENARIO ?? "meeting") === "one_to_one" ? "open" : "addressed_only");
const botName = env.RECALL_BOT_NAME ?? "Yui";
/**
 * The room may take a while to let two bots in; nobody is billed for the script until they are. Meet itself
 * gives up a knock after about 10 minutes (「No one responded to your request to join」 → Attendee reports
 * request_to_join_denied, runs 27–28), and Attendee gives up an unanswered one after its own
 * `waiting_room_timeout_seconds` (900 s). A knock that dies unadmitted is knocked again until this budget
 * is spent, so a large value parks the bots at the door: launch first, admit when the room is ready
 * (`ADMIT_TIMEOUT=3600`). Each dead knock leaks an Xvfb + Chromium pair in the self-hosted worker;
 * `PARK_RESTART_WORKER=1` restarts the worker before a re-knock when the pre-flight count says so.
 */
const admitTimeoutS = Number(process.env.ADMIT_TIMEOUT ?? 300);
const PARK_RESTART_WORKER = process.env.PARK_RESTART_WORKER === "1";
/**
 * `KEEP_ROOM=1`: after the script the bots stay in the call instead of leaving, and the script runs
 * again whenever `<run dir>/rerun` appears (`stop` ends the run). One admission, as many passes as
 * the room allows — a pass spoiled by an open microphone is repeated without another knock at the
 * door. Only the harness side changes between passes: the character's page and the agent are the
 * ones that were admitted.
 */
const KEEP_ROOM = process.env.KEEP_ROOM === "1";
/** How far before T0 (the Tester's admission) a greeting still counts: the whole admission wait. */
const GREETING_LOOKBACK_MS = Number(process.env.ADMIT_TIMEOUT ?? 1800) * 1000;
/** The Tester's recording: Yui's tile is read from it, so 1080p unless the bot host cannot keep up (self-hosted, emulated). */
const TESTER_RESOLUTION = process.env.TESTER_RESOLUTION ?? "1080p";
/**
 * Yui's own recording is never read here (her tile is not in it). YUI_RECORDING_FORMAT=mp3 drops its screen capture on a
 * bot host that is short of CPU, and 720p shrinks her Chrome window with it (Attendee sizes the window from the recording
 * resolution), so Meet sends that browser smaller tiles to decode.
 */
const YUI_RECORDING = process.env.YUI_RECORDING_FORMAT ? { recording: { format: process.env.YUI_RECORDING_FORMAT, resolution: TESTER_RESOLUTION } } : {};
/**
 * TESTER_RECORDING_FORMAT=mp3 keeps the Tester's ears and drops its screen capture (720p H.264 in the bot host's
 * browser VM, plus the decode of every tile it needs). Run 70 lost two thirds of a question inside the vendor's
 * capture while that VM sat at 500 %: the tile frames are evidence from earlier runs, the answers are the gate.
 */
const TESTER_RECORDING = process.env.TESTER_RECORDING_FORMAT ?? "mp4";

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
/**
 * The bot host itself, when it is the self-hosted Attendee in Docker. Run 75's ears were six Chromium
 * pairs leaked from expired knocks (swap full); run 76's Tester sat 2 m 44 s unlaunched in a worker with
 * 70 leaked Xvfb. Two bots own two of each; anything above that is a knock that was never cleaned up.
 * Counted, printed, and a warning — not a block: the operator decides whether to restart the worker.
 */
const WORKER = process.env.ATTENDEE_WORKER ?? "attendee-attendee-worker-local-1";
function preflightWorker() {
  try {
    const out = execFileSync("docker", ["exec", WORKER, "sh", "-c", "echo $(ps -eo comm | grep -c '^Xvfb') $(ps -eo comm | grep -ci 'chrom') $(free -m | awk '/Swap/{print $3} /Mem/{print $7}' | tr '\n' ' ')"], { encoding: "utf8", timeout: 10_000 }).trim();
    const [xvfb, chromium, availMb, swapMb] = out.split(/\s+/).map(Number);
    const stale = xvfb > 2 || chromium > 4;
    console.log(`preflight: bot host ${WORKER}: Xvfb ${xvfb} · Chromium ${chromium} · ${availMb} MB available · swap ${swapMb} MB${stale ? " — STALE BOTS LEAKED: docker restart " + WORKER + " before knocking" : ""}`);
    return { xvfb, chromium, availMb, swapMb, stale };
  } catch (err) { console.log(`preflight: bot host not inspected (${err.message.split("\n")[0]})`); return null; }
}
const preWorker = preflightWorker();
/**
 * The page the character lives in. Run 88: the Vite dev server's HMR client reloads the page once its
 * socket to the server drops and comes back (a tunnel hiccup is enough — `location.reload()` on reconnect),
 * and the reloaded page cannot re-activate (single-use token), so Yui went deaf and mute for passes 3–4
 * with both bots still in the room. The gate wants the built app (`pnpm --filter @rcai/web build` served
 * by `vite preview`), which carries no HMR client; a dev-served page is refused unless ALLOW_DEV_BOT_PAGE=1.
 */
async function preflightBotPage() {
  const page = env.RECALL_BOT_PAGE_URL;
  if (!page) return { ok: false, error: "RECALL_BOT_PAGE_URL is not set in services/token-broker/.env (scripts/reality/meet-setup.sh start)" };
  try {
    const res = await fetch(`${page.replace(/\/$/, "")}/?rcai_bot=1`, { signal: AbortSignal.timeout(15_000) });
    const html = await res.text();
    return { ok: res.ok, status: res.status, dev: /\/@vite\/client/.test(html), host: new URL(page).host };
  } catch (err) { return { ok: false, error: err.cause?.code ?? err.message, host: new URL(page).host }; }
}
/**
 * The two public URLs the bot page is handed and can only reach through the internet: the broker's relay
 * (RECALL_PUBLIC_URL) and the agent's WebSocket (RECALL_AGENT_PUBLIC_URL). Run 91: the host had rebooted,
 * meet-setup.sh had re-opened the broker and page tunnels, and the agent's tunnel — opened by hand — was
 * gone with its hostname; the page loaded, the room heard nothing, and four passes ran deaf and mute
 * (`turn=none` ×16) with every pre-flight green. Both must answer from here before a knock.
 */
async function preflightPublicUrl(name, url, path) {
  if (!url) return { ok: false, error: `${name} is not set in services/token-broker/.env` };
  const http = url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/$/, "");
  try {
    const res = await fetch(`${http}${path}`, { signal: AbortSignal.timeout(15_000) });
    return { ok: res.ok, status: res.status, host: new URL(http).host };
  } catch (err) { return { ok: false, error: err.cause?.code ?? err.message, host: new URL(http).host }; }
}
for (const [name, path] of [["RECALL_PUBLIC_URL", "/health"], ["RECALL_AGENT_PUBLIC_URL", "/health"]]) {
  const r = await preflightPublicUrl(name, env[name], path);
  if (!r.ok) { console.log(`BLOCKED_BY_PUBLIC_URL: ${name} ${r.host ?? ""} ${r.error ?? `HTTP ${r.status}`} — the bot page reaches it only through this URL; re-open the tunnel (scripts/reality/meet-setup.sh start) and restart the broker`); process.exit(2); }
  console.log(`preflight: ${name} ${r.host} · answers`);
}
const prePage = await preflightBotPage();
if (!prePage.ok) { console.log(`BLOCKED_BY_BOT_PAGE: ${prePage.host ?? ""} ${prePage.error ?? `HTTP ${prePage.status}`} — the bot page must answer before a knock`); process.exit(2); }
if (prePage.dev && process.env.ALLOW_DEV_BOT_PAGE !== "1") { console.log(`BLOCKED_BY_DEV_BOT_PAGE: ${prePage.host} is the Vite dev server (HMR client present) — it reloads the character out of the room on a tunnel hiccup (run 88).\n  pnpm --filter @rcai/web build && pnpm --filter @rcai/web preview --port 5180, point RECALL_BOT_PAGE_URL at it (meet-setup.sh prefers 5180), or ALLOW_DEV_BOT_PAGE=1 to accept the risk`); process.exit(2); }
console.log(`preflight: bot page ${prePage.host} · ${prePage.dev ? "vite dev server (HMR client present — accepted by ALLOW_DEV_BOT_PAGE)" : "built app, no HMR client"}`);
if (process.env.PREFLIGHT_ONLY) process.exit(0); // `PREFLIGHT_ONLY=1 pnpm reality:attendee:auto`: check the agent and the bot host, create nothing

/**
 * Run 93: the bot host's Docker VM stopped mid-pass (its disk image hit write errors on a 98 %-full host
 * disk) and the first `fetch` to the vendor threw ECONNREFUSED out of `speak()` — the harness died with
 * both bots' records still open and no report for the passes it had. A vendor that cannot be reached is a
 * failed call, not a crash: it is reported like any other non-2xx and the pass keeps its verdicts.
 */
let vendorDownSince = 0;
const api = async (path, init = {}) => {
  let r;
  try {
    r = await fetch(`${attendee}/api/v1/bots${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000), headers: { Authorization: `Token ${env.ATTENDEE_API_KEY}`, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
  } catch (err) {
    const code = err.cause?.code ?? err.name ?? err.message;
    if (!vendorDownSince) { vendorDownSince = Date.now(); console.log(`BLOCKED_BY_BOT_HOST: the vendor API at ${attendee} did not answer (${code}) — the bot host is down; the pass continues on what the room still delivers`); }
    return { ok: false, status: 0, body: String(code) };
  }
  if (vendorDownSince) { console.log(`   (vendor API back after ${Math.round((Date.now() - vendorDownSince) / 1000)} s)`); vendorDownSince = 0; }
  return await apiBody(r);
};
const apiBody = async (r) => {
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
const MEETING_CUES = [
  { id: "greet", at: 0, kind: "listen", expect: "入室の挨拶をする", window: 25 },
  { id: "chat", at: 25, kind: "conversation", lines: [[VOICE_A, "昨日の資料、見てくれた？"], [VOICE_B, "見たよ。三ページ目の数字が少し気になったかな。"], [VOICE_A, "あそこは後で直しておくね。"], [VOICE_B, "ありがとう、助かる。"]], expect: "割り込まない", window: 30 },
  { id: "ask1", at: 65, kind: "say", voice: VOICE_A, text: "ゆい、今日の予定を教えて。", expect: "答える", window: 15 },
  // The same person, no name: the conversation continues (an engaged follow-up, seen by accident in run 47).
  { id: "followup", at: 95, kind: "say", voice: VOICE_A, text: "それって、来週までに終わりそう？", expect: "名前なしでも続けて答える", window: 15 },
  { id: "third", at: 135, kind: "say", voice: VOICE_A, text: "ゆいが昨日そう言ってたよね。", expect: "答えない", window: 15 },
  { id: "bargein", at: 175, kind: "interrupt", voice: VOICE_A, text: "ゆい、これはどう思う？", cutIn: { voice: VOICE_B, text: "ちょっと待って、その前にこっちの話を先にさせて。" }, expect: "AIが止まる", window: 30 },
  { id: "ask2", at: 220, kind: "say", voice: VOICE_A, text: "ゆい、今どう思う？", expect: "答える", window: 15 },
  { id: "silence", at: 260, kind: "listen", expect: "勝手に話さない", window: 30 },
];

const SCENARIOS = { meeting: { cues: MEETING_CUES, end: 300 }, one_to_one: { cues: oneToOneCues(VOICE_A, VOICE_B), end: 345 } };
const SCENARIO = process.env.SCENARIO ?? "meeting";
if (!SCENARIOS[SCENARIO]) { console.log(`BLOCKED_BY_SCENARIO: SCENARIO=${SCENARIO} is not one of ${Object.keys(SCENARIOS).join(", ")}`); process.exit(2); }
const CUES = SCENARIOS[SCENARIO].cues;
const SCRIPT_END = SCENARIOS[SCENARIO].end;

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
const LEAD_IN_MS = Number(process.env.LEAD_IN_MS ?? 800);
/**
 * Room tone, not digital silence: Meet's captions of run 69 read the Tester's own 「ゆい、今日の予定を教えて。」
 * as 「今日の予定を教えて。」 and 「ゆい、今どう思う？」 as 「今どう思う？」 — the name was gone before the
 * sound left the Tester, on a lead-in of 400 ms of zeros. A sender-side gate opens on sound; the lead-in
 * is now faint pink noise (−50 dBFS) so the track is already "live" when the name starts.
 */
const LEAD_IN_NOISE = Number(process.env.LEAD_IN_NOISE ?? 0.003);
/** @returns {{ mp3: string, seconds: number }} */
function render(voice, text, name) {
  const aiff = join(dir, `${name}.aiff`);
  const mp3 = join(dir, `${name}.mp3`);
  execFileSync("say", ["-v", voice, "-o", aiff, text]);
  const lead = `anoisesrc=d=${(LEAD_IN_MS / 1000).toFixed(3)}:c=pink:a=${LEAD_IN_NOISE}:r=24000,aformat=sample_fmts=fltp:channel_layouts=mono[n];[0:a]aformat=sample_fmts=fltp:sample_rates=24000:channel_layouts=mono[v];[n][v]concat=n=2:v=0:a=1[out]`;
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, "-filter_complex", lead, "-map", "[out]", "-ac", "1", "-ar", "24000", "-b:a", "64k", mp3]);
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
async function knock() {
  const yui = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      meetingUrl: url, botName, ...YUI_RECORDING,
      botPageQuery: { engine, character: process.env.CHARACTER_ID ?? "yui", name: botName, language: "ja-JP", proactivity, persona: process.env.PERSONA_ID ?? (SCENARIO === "one_to_one" ? "friend_ja" : "meeting_colleague_ja"), vision: process.env.VISION ?? "cues", ...(process.env.VOICE ? { voice: process.env.VOICE } : {}), ...(process.env.FRAMING ? { framing: process.env.FRAMING } : {}), ...(process.env.YUI_PAGE_FPS ? { fps: process.env.YUI_PAGE_FPS } : {}), outbound: "page" },
    }),
  })).json();
  if (!yui.botId) { console.log(`FAIL: ${yui.error ?? "join failed"} ${yui.detail ?? ""}`); process.exit(1); }

  const tester = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
    method: "POST", headers: { "content-type": "application/json" },
    // The Tester's transcript comes from Meet's own captions unless told otherwise: the self-hosted
    // Attendee has no Deepgram credential, and with one asked for anyway the "room heard the character"
    // row read 0/0 for four admitted runs (44–47) without saying why.
    body: JSON.stringify({ meetingUrl: url, botName: "Tester", role: "listener", botPageQuery: { language: "ja-JP" }, transcription: process.env.TESTER_TRANSCRIPTION ?? "closed_captions", recording: { view: "gallery_view", resolution: TESTER_RESOLUTION, format: TESTER_RECORDING } }),
  })).json();
  if (!tester.botId) {
    console.log(`FAIL: tester ${tester.error ?? "join failed"} ${tester.detail ?? ""}`);
    await fetch(`${broker}/api/meeting/attendee/bots/${yui.botId}/leave`, { method: "POST" }).catch(() => {});
    process.exit(1);
  }
  console.log(`\n=== 自動 実会議 Gate (Attendee × 2) ===\n${botName} ${yui.botId}  Tester ${tester.botId}  engine=${engine}  proactivity=${proactivity}  platform=${platform}`);
  console.log(`>>> Meet で「${botName}」と「Tester」の参加を承認してください（${admitTimeoutS}s 以内）。\n`);
  return { yui, tester };
}
let { yui, tester } = await knock();

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
/**
 * A Tester line is excluded from "room audio" by the window in which the harness sent it — but its sound
 * reaches the relay only after Attendee → Meet → Yui's bot → broker, 2–3 s later, so the clip's tail
 * landed outside its window and counted as the character. Runs 90, 98, 100 and 101 each had one `bargein`
 * PARTIAL on "6.2–6.4 s of sound after the interrupted" while the Tester's recording (run 101, decoded)
 * showed the yield 「はい。」, the answer's in-flight tail and the cut-in's own words — nothing else. The
 * exclusion window is padded by the transport lag (SPOKEN_LAG_MS).
 */
const SPOKEN_LAG_MS = Number(process.env.SPOKEN_LAG_MS ?? 2500);
const inSpoken = (t, windows) => windows.some(([a, b]) => t >= a && t <= b + SPOKEN_LAG_MS);
/** Seconds of audible room audio inside [from, to] (epoch ms), excluding what the Tester itself was saying. */
const audibleSeconds = (from, to, exclude = []) => {
  const pts = heard.filter((h) => h.t >= from && h.t <= to && !inSpoken(h.t, exclude));
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
/** A poll that cannot reach the vendor reads "?" and the loop goes on (run 87: the bot host's Docker VM stopped mid-knock and a hung fetch took the whole run down). */
const state = async (id) => {
  try { return (await api(`/${id}`, { signal: AbortSignal.timeout(15_000) })).body?.state ?? "?"; }
  catch (err) { return `?(${err.cause?.code ?? err.name})`; }
};
const t0 = Date.now();
let joined = false;
let knocks = 1;
while (Date.now() - t0 < admitTimeoutS * 1000) {
  const [a, b] = await Promise.all([state(yui.botId), state(tester.botId)]);
  process.stdout.write(`\r   ${botName}=${a}  Tester=${b}  (${Math.round((Date.now() - t0) / 1000)}s)   `);
  if (IN_CALL.has(a) && IN_CALL.has(b)) { joined = true; break; }
  if (["fatal_error", "ended"].includes(a) || ["fatal_error", "ended"].includes(b)) {
    // A knock nobody answered (Meet's ~10 min, or the vendor's waiting-room timeout). Knock again while the budget lasts.
    const left = admitTimeoutS - (Date.now() - t0) / 1000;
    console.log(`\n   knock ${knocks} died unadmitted (${botName}=${a} Tester=${b}); ${left > 60 ? `knocking again (${Math.round(left)}s of budget left)` : "budget spent"}`);
    if (left <= 60) break;
    await leaveAll();
    const w = preflightWorker();
    if (w?.stale && PARK_RESTART_WORKER) {
      try { execFileSync("docker", ["restart", WORKER], { stdio: "pipe", timeout: 60_000 }); await sleep(8000); console.log(`   worker restarted (Xvfb ${w.xvfb} · Chromium ${w.chromium})`); } catch (err) { console.log(`   worker restart failed: ${err.message.split("\n")[0]}`); }
    }
    ({ yui, tester } = await knock());
    knocks++;
    continue;
  }
  await sleep(3000);
}
console.log("");
if (!joined) { console.log(`FAIL: both bots were not admitted in time (${knocks} knock${knocks > 1 ? "s" : ""})`); await leaveAll(); process.exit(1); }
/**
 * Let the bot host settle before the first cue. Run 97: the Tester was admitted 715 s after Yui and the
 * script started the moment it was in — while its browser was still joining and the recording spinning
 * up. The first question landed in that spike: a cache-hit prompt of 87 tokens took 10.2 s to the first
 * token (117 ms a token against 2), the rescore 3.6 s, and the Tester heard 1.0 s of the answer inside
 * the window. Twenty seconds of quiet first (`SETTLE_MS` to change).
 */
const settleMs = Number(process.env.SETTLE_MS ?? 20_000);
if (settleMs > 0) { console.log(`   (両方入室 — bot host が落ち着くまで ${Math.round(settleMs / 1000)} s 待機)`); await sleep(settleMs); }
let T0 = Date.now();
console.log(`両方入室 (${Math.round((T0 - t0) / 1000)}s)。スクリプト開始。${KEEP_ROOM ? ` (KEEP_ROOM: 退室せず、${dir}/rerun で再実行、${dir}/stop で終了)` : ""}\n`);

// ---- page reports, from the broker ---------------------------------------------------------------
/** The broker's view of the character's ears: chunk/hole counts and the last holes with their times. */
const relayStatus = async () => { try { return await (await fetch(`${broker}/api/meeting/recall/relay-status/${encodeURIComponent(yui.botId)}`)).json(); } catch { return null; } };

/**
 * The room has to be audible before a cue is worth playing. Run 104: both bots joined, the page
 * activated, and neither bot's audio ever reached the broker (0 chunks on either relay) — four passes
 * ran against a deaf character before anyone looked. The character's relay must carry chunks within
 * AUDIO_CHECK_S of the settle; otherwise the run is `BLOCKED_BY_BOT_AUDIO` and the bots leave.
 */
{
  const audioCheckS = Number(process.env.AUDIO_CHECK_S ?? 30);
  const started = Date.now();
  let chunks = 0;
  while (Date.now() - started < audioCheckS * 1000) {
    const st = await relayStatus();
    chunks = st?.audio?.chunks ?? 0;
    if (chunks > 0) break;
    await sleep(2000);
  }
  if (chunks === 0) {
    console.log(`BLOCKED_BY_BOT_AUDIO: no audio reached the character's relay within ${audioCheckS} s of admission (the vendor's mixed-audio websocket never connected) — leaving`);
    await leaveAll();
    process.exit(2);
  }
  console.log(`   (relay carrying audio: ${chunks} chunks)`);
}
T0 = Date.now(); // the clock starts once the room is known to be audible

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

let results = [];
let audio = []; // per answered cue: { id, quality, reply, echo }
let finalPage = {};
let passNo = 0;
let hostSamples = [];
/**
 * `spoke` is logged when the page finishes playing, which is often after the cue's window has closed
 * (run 47: ask1 answered inside the window, `spoke` at 81.2 s against a window ending at 80 s — read
 * as `reply=""`, and the parrot check came out UNKNOWN on a run with two perfectly good answers). The
 * page state has it; an answer that began in the window is that cue's, wherever it ended. Read at each
 * pass's end as well as the run's — on a kept room only the last pass reached this step, and runs 89
 * and 90 filed two good answers a pass as `reply=""`.
 */
function readLateReplies() {
  for (const a of audio) {
    if (a.reply) continue;
    // An answer that was cut carries its text on `interrupted` instead (run 63: three cut answers, 0 replies read).
    const late = eventsBetween(finalPage.pageEvents ?? [], a.start, a.end + 20_000, "spoke");
    const cut = late.length ? [] : eventsBetween(finalPage.pageEvents ?? [], a.start, a.end + 20_000, "interrupted").filter((e) => e.data?.text);
    if (!late.length && !cut.length) continue;
    a.reply = (late.length ? late : cut).map((e) => e.data?.text ?? "").join(" / ") + (cut.length ? " (cut)" : "");
    a.echo = NAME_ECHO.test(a.reply);
    const sentS = late.reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
    if (late.length) a.quality = audioQuality(a.start, a.end, spoken, sentS) ?? a.quality;
    const r = results.find((x) => x.id === a.id);
    if (r) r.detail = r.detail.replace('reply=""', `reply=${JSON.stringify(a.reply.slice(0, 60))}${a.echo ? " NAME-ECHO" : ""} (spoke after the window)`);
  }
}
for (;;) {
results = [];
audio = [];
spoken.length = 0;
passNo++;
if (passNo > 1) { T0 = Date.now(); console.log(`\n=== pass ${passNo} (T0 reset) ===\n`); }
/**
 * The bot host's load while the pass runs — run 77 read it only after the bots had left (low), which
 * said nothing about the five minutes that mattered. `docker stats` every 15 s, kept with the holes.
 */
hostSamples = [];
const hostSampler = preWorker && setInterval(() => {
  execFile("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}} {{.MemUsage}}", WORKER], { encoding: "utf8", timeout: 12_000 }, (err, out) => {
    if (!err) hostSamples.push({ s: Math.round((Date.now() - T0) / 1000), stat: out.trim() });
  });
}, 15_000);
for (const cue of CUES) {
  await at(cue.at);
  const start = Date.now();
  console.log(`${stamp(start - T0)}  [${cue.id}] ${cue.text ?? cue.kind}\n        期待: ${cue.expect}`);
  let cutAt = null;
  let heardAt = null;
  if (cue.kind === "say") await speak(cue.id);
  else if (cue.kind === "conversation") for (let i = 0; i < cue.lines.length; i++) { await speak(`${cue.id}:${i}`); await sleep(1200); }
  else if (cue.kind === "interrupt") {
    const asked = await speak(cue.id);
    /**
     * Cut in when the Tester *hears* her, not when the page says `speaking`: that event fires on the
     * first phrase text, and under host load the first audio follows it by ~4 s and reaches the room
     * ~4 s after that (run 63: the cut-in arrived after a 9 s answer had finished — PARTIAL with the
     * mechanism never exercised). A person interrupts a sentence they can hear, a beat into it.
     */
    const deadline = Date.now() + Number(process.env.CUT_DEADLINE_MS ?? 20_000);
    while (Date.now() < deadline) {
      if (audibleSeconds(asked.to, Date.now(), spoken) >= 0.3) { heardAt = Date.now(); break; }
      await sleep(100);
    }
    if (heardAt) await sleep(Number(process.env.CUT_AFTER_HEARD_MS ?? 1500));
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
      // Run 96: Yui was let in 118 s before the Tester and greeted at T0−118 s — outside a 60 s look-back,
      // scored `greeting=none` against a greeting the admitter heard. The admission gap is however long
      // the admitter takes; the greeting is once per admission, so the whole admission is the window.
      const greeting = eventsBetween(ev, T0 - GREETING_LOOKBACK_MS, end, "greeting");
      const gAt = greeting[0]?.at ?? start;
      // A greeting sanctioned late in the window is still judged on its own 15 s (run 69: greeted at
      // 22.4 s, speaking at 25.8 s against a window closing at 25 s — scored FAIL on the clock).
      const gEnd = Math.max(end, gAt + 15_000);
      const spokeAfter = eventsBetween(ev, gAt, gEnd, "speaking").length;
      const frames = eventsBetween(ev, gAt, gEnd, "spoke").reduce((n, e) => Math.max(n, e.data?.frames ?? 0), 0);
      // KEEP_ROOM: the greeting is once per admission, so from the second pass on there is nothing to judge.
      status = passNo > 1 ? "N/A" : greeting.length && (spokeAfter || heardS > 0.5) ? "PASS" : "FAIL";
      detail = `${passNo > 1 ? `greeting is once per admission (pass ${passNo}) · ` : ""}greeting=${greeting.map((e) => `${JSON.stringify(e.data)}@${((e.at - T0) / 1000).toFixed(1)}s`).join(",") || "none"} speaking=${spokeAfter} spoke=${frames}f heard=${heardS.toFixed(1)}s${gAt < start ? " (before the Tester joined: not audible to it)" : ""}`;
      break;
    }
    case "ask1": case "ask2": case "followup": {
      const spoke = eventsBetween(ev, start, end, "spoke");
      const reply = spoke.map((e) => e.data?.text ?? "").join(" / ");
      const sentS = spoke.reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
      // The page sent an answer and the Tester captured none of it: that is the Tester's ear, not the
      // character's voice (run 75: its capture went to digital silence mid-run while the admitter heard
      // her). Neither PASS nor FAIL — UNHEARD, and the admitter's ear decides.
      status = turns.length && speaking.length && heardS > 0.5 ? "PASS" : turns.length && speaking.length && sentS > 1 ? "UNHEARD" : turns.length ? "PARTIAL" : "FAIL";
      detail = `turn=${turns.map((e) => e.data.reason).join(",") || "none"} speaking=${speaking.length} heard=${heardS.toFixed(1)}s${status === "UNHEARD" ? ` (page sent ${sentS.toFixed(1)}s the Tester never captured)` : ""}`;
      const q = audioQuality(start, end, spoken, sentS);
      const echo = reply ? NAME_ECHO.test(reply) : false;
      audio.push({ id: cue.id, quality: q, reply, echo, start, end });
      detail += ` · reply=${JSON.stringify(reply.slice(0, 60))}${echo ? " NAME-ECHO" : ""} · audio: ${audioLine(q)}${q?.issues.length ? ` ⚠ ${q.issues.join(", ")}` : ""}`;
      break;
    }
    case "third": case "chat": case "silence": {
      // The greeting's own audio starting inside the next window is the greeting, not an interruption.
      const greetings = eventsBetween(ev, T0 - GREETING_LOOKBACK_MS, end, "greeting");
      const own = speaking.filter((e) => !greetings.some((g) => e.at >= g.at && e.at - g.at < 15_000));
      // Run 78 pass 1: the admitter's microphone held the floor until 24 s, the greeting came at 26 s — into
      // the chat cue, where its `turn` event failed a cue whose speaking it was already forgiven.
      // A turn the rescore withdrew before any audio (`withdrawn`) is a turn the room never heard: the
      // page changed its mind in time, which is the behaviour these cues ask for. Shown, not scored.
      const withdrawn = eventsBetween(ev, start, end, "withdrawn").length;
      const ownTurns = turns.filter((t) => t.data?.reason !== "joined the meeting");
      const heldTurns = Math.max(0, ownTurns.length - withdrawn);
      status = !heldTurns && !own.length ? "PASS" : "FAIL";
      detail = `turn=${heldTurns}${withdrawn ? ` (+${withdrawn} withdrawn)` : ""}${ownTurns.length !== turns.length ? ` (+${turns.length - ownTurns.length} greeting)` : ""} speaking=${own.length}${own.length !== speaking.length ? ` (+${speaking.length - own.length} greeting)` : ""} heard=${heardS.toFixed(1)}s`;
      break;
    }
    case "bargein": {
      /**
       * Judged on the mechanism and its tail: the page reported `interrupted`, and the room fell quiet
       * within STOP_TAIL_S of that (audio already in flight to the room keeps playing for the page→room
       * latency, 3–4 s in run 63). "Quiet" is the first 1.5 s of silence after the interruption, so an
       * answer to the cut-in itself (run 47: 「承知しました。そちらの対応を優先しましょう。」) is not a tail.
       */
      const STOP_TAIL_S = Number(process.env.STOP_TAIL_S ?? 5);
      const iAt = interrupted[0]?.at ?? null;
      let stopAt = null;
      if (iAt) {
        const pts = heard.filter((h) => h.t >= iAt && h.t <= end && !inSpoken(h.t, spoken));
        let quietFrom = null;
        stopAt = iAt;
        for (const h of pts) {
          if (h.db > FLOOR_DB) { quietFrom = null; stopAt = h.t; }
          else if (quietFrom == null) quietFrom = h.t;
          else if (h.t - quietFrom >= 1500) break;
        }
      }
      const tailS = iAt ? (stopAt - iAt) / 1000 : null;
      const afterCut = cutAt ? audibleSeconds(cutAt + 1500, cutAt + 5000, spoken) : 0;
      /**
       * The verdict is the character's own sound after the cut-in — `afterCut`, 1.5–5 s after it, the
       * Tester's lines excluded — not the tail scan. The scan looks for 1.5 s of quiet after the
       * `interrupted`, and with the Tester's cut-in excluded (padded by its transport lag) the quiet it
       * finds is broken by the yield 「はい。」 and its own gaps: run 102 read 5.9–7.0 s in three passes
       * whose `afterCut` was 0.0 s, as run 101's recording had shown. The tail stays in the detail.
       */
      const AFTER_CUT_S = Number(process.env.AFTER_CUT_S ?? 1.0);
      status = speaking.length && interrupted.length && afterCut < AFTER_CUT_S ? "PASS" : speaking.length ? "PARTIAL" : "FAIL";
      const rel = (t) => (t ? `+${((t - start) / 1000).toFixed(1)}s` : "none");
      detail = `speaking=${speaking.length} interrupted=${interrupted.length} · heard her ${rel(heardAt)} cut-in ${rel(cutAt)} interrupted ${rel(iAt)}${tailS != null ? ` quiet ${tailS.toFixed(1)}s after that` : ""} · audible 1.5–5s after the cut-in=${afterCut.toFixed(1)}s`;
      const cutText = interrupted.map((e) => e.data?.text ?? "").filter(Boolean).join(" / ");
      if (cutText) { const echo = NAME_ECHO.test(cutText); audio.push({ id: cue.id, quality: null, reply: cutText, echo, start, end }); detail += ` · reply(cut)=${JSON.stringify(cutText.slice(0, 60))}${echo ? " NAME-ECHO" : ""}`; }
      break;
    }
    default: {
      /**
       * A cue that says what it wants: an answer, or silence. What she actually said is printed with
       * it, because for these the words are the test — a company nobody has heard of and a document
       * nobody sent are both answered "correctly" by a character that simply makes something up.
       */
      if (cue.want === "answer" || cue.want === "silence") {
        const spoke = eventsBetween(ev, start, end, "spoke");
        const reply = spoke.map((e) => e.data?.text ?? "").join(" / ");
        const sentS = spoke.reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
        if (cue.want === "answer") {
          status = turns.length && speaking.length && heardS > 0.5 ? "PASS" : turns.length && speaking.length && sentS > 1 ? "UNHEARD" : turns.length ? "PARTIAL" : "FAIL";
        } else {
          const own = speaking.filter((e) => !eventsBetween(ev, T0 - GREETING_LOOKBACK_MS, end, "greeting").some((g) => e.at >= g.at && e.at - g.at < 15_000));
          status = !turns.length && !own.length ? "PASS" : "FAIL";
        }
        const q = cue.want === "answer" ? audioQuality(start, end, spoken, sentS) : null;
        const echo = reply ? NAME_ECHO.test(reply) : false;
        if (reply) audio.push({ id: cue.id, quality: q, reply, echo, start, end });
        detail = `turn=${turns.map((e) => e.data.reason).join(",") || "none"} speaking=${speaking.length} heard=${heardS.toFixed(1)}s · reply=${JSON.stringify(reply.slice(0, 90))}${echo ? " NAME-ECHO" : ""}${q ? ` · audio: ${audioLine(q)}` : ""}`;
        break;
      }
      status = "INFO"; detail = "";
    }
  }
  results.push({ id: cue.id, expect: cue.expect, status, detail });
  writeFileSync(join(dir, "progress.json"), JSON.stringify({ T0, results, pageEvents: (await pageState()).pageEvents }));
  console.log(`        → ${status}  ${detail}\n`);
}
await at(SCRIPT_END);
finalPage = await pageState();
/**
 * Where the character's ears went during this pass, on the vendor's own clock. Run 77 pass 1: 139 holes
 * and 14 604 zero frames with the bot host's memory fine — the totals said "degraded", not when, so the
 * cue that lost its question could not be matched to the hole that took it. The broker keeps the last 64
 * holes with its arrival clock; printed against T0 they line up with the cue schedule above.
 */
if (hostSampler) clearInterval(hostSampler);
if (hostSamples.length) console.log(`bot host during the pass (s from T0 → cpu mem): ${hostSamples.map((h) => `${h.s}→${h.stat}`).join("  ")}`);
const passRelay = await relayStatus();
if (passRelay?.audio) {
  const ra = passRelay.audio;
  const inPass = (ra.holes ?? []).filter((h) => h.at >= T0 - 30_000);
  console.log(`ears (vendor → broker) this pass: ${inPass.length} holes >250 ms shown of ${ra.gaps} total (${(ra.gapMs / 1000).toFixed(1)}s) · ${ra.zeroChunks}/${ra.chunks} chunks exact zeros since the bot joined`);
  if (inPass.length) console.log(`  holes at (s from T0 → length): ${inPass.map((h) => `${((h.at - T0) / 1000).toFixed(0)}→${(h.ms / 1000).toFixed(1)}s`).join("  ")}`);
}
if (!KEEP_ROOM) break;
// ---- stay: the room is kept, the script is repeated on request ----------------------------------
readLateReplies();
for (const r of results) if (r.detail.includes("spoke after the window")) console.log(`  ${r.id}: ${r.detail.match(/reply=("[^"]*"[^·]*)/)?.[1] ?? ""}`);
writeFileSync(join(dir, `report-pass${passNo}.json`), JSON.stringify({ T0, results, audio, pageEvents: finalPage.pageEvents, relay: passRelay, host: hostSamples }, null, 2));
console.log(`\n(KEEP_ROOM) pass ${passNo} 終了、退室せずに待機。再実行: touch ${dir}/rerun · 終了: touch ${dir}/stop`);
let again = false;
for (;;) {
  const [a, b] = await Promise.all([state(yui.botId), state(tester.botId)]);
  if (!IN_CALL.has(a) || !IN_CALL.has(b)) { console.log(`\n(KEEP_ROOM) a bot left the call (${botName}=${a} Tester=${b}): finishing`); break; }
  if (existsSync(join(dir, "stop"))) break;
  if (existsSync(join(dir, "rerun"))) { unlinkSync(join(dir, "rerun")); again = true; break; }
  await sleep(2000);
}
if (!again) break;
}

// ---- leave, then read the Tester's recording ------------------------------------------------------
await leaveAll();
earsOpen = false;
ears.close();
const beat = finalPage.pageHeartbeat?.data ?? {};
readLateReplies();
console.log(`\n| step | status | detail |\n|---|---|---|`);
const row = (n, s, d) => console.log(`| ${n} | ${s} | ${d} |`);
row("voice agent page started", finalPage.activations > 0 ? "PASS" : "FAIL", finalPage.activations > 0 ? `activated at ${new Date(finalPage.botPageActivatedAt).toISOString()}` : "the page never loaded");
row("page render rate", beat.fps == null ? "UNKNOWN" : beat.fps >= 20 ? "PASS" : "LOW", `${beat.fps ?? "?"} fps at the last heartbeat · avatar=${beat.avatar ?? "?"}`);
row("tester heard the room", chunks > 0 ? "PASS" : "FAIL", `${chunks} chunks on the Tester's relay`);
/**
 * Whether the character's ears were continuous, at the two places it can be measured: the vendor's own
 * stamp on each mixed chunk as it reaches the broker, and the page's arrival clock. A hole at the broker
 * is a hole in the vendor's capture (its recording is a different path and can still be intact).
 */
const relayStat = await relayStatus();
const ra = relayStat?.audio;
row("character's ears continuous (vendor → broker)", !ra ? "UNKNOWN" : ra.gapMs > 2000 ? "DEGRADED" : "PASS", ra ? `${ra.chunks} chunks · ${ra.gaps} holes >250 ms totalling ${(ra.gapMs / 1000).toFixed(1)}s (by the vendor's timestamp_ms) · ${ra.zeroChunks ?? "?"} chunks exact zeros` : "relay-status unavailable");
row("character's ears continuous (broker → page)", beat.heardMs == null ? "UNKNOWN" : beat.zeroFrames > 0.2 * beat.heard || beat.gaps > 20 ? "DEGRADED" : "PASS", beat.heardMs == null ? "page heartbeat carries no continuity counters" : `${(beat.heardMs / 1000).toFixed(1)}s delivered in ${beat.heard} frames · ${beat.zeroFrames} all-zero frames · ${beat.gaps} arrival holes >250 ms`);
// The Tester's own ear over the whole pass: everything the page sent, against what the Tester captured
// once its own lines are taken out. Both near zero in a muted room is fine; sent ≫ heard is a dead ear.
const passSentS = eventsBetween(finalPage.pageEvents ?? [], T0 - 60_000, Date.now(), "spoke").reduce((n, e) => n + (e.data?.seconds ?? 0), 0);
const passHeardS = audibleSeconds(T0, Date.now(), spoken);
row("tester's ear alive", passSentS > 5 && passHeardS < 1 ? "DEAD" : passSentS > 5 && passHeardS < 0.3 * passSentS ? "DEGRADED" : "PASS", `page sent ${passSentS.toFixed(1)}s this pass · Tester captured ${passHeardS.toFixed(1)}s of the room (its own lines excluded)`);
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
  const mp4 = join(dir, `tester.${TESTER_RECORDING}`);
  writeFileSync(mp4, Buffer.from(await (await fetch(rec.url)).arrayBuffer()));
  const framesDir = join(dir, "frames");
  mkdirSync(framesDir, { recursive: true });
  // One frame per cue, at the moment an answer was expected: what the room saw of the character.
  const recStart = rec.start_timestamp_ms ?? T0;
  if (TESTER_RECORDING === "mp4") for (const cue of CUES) {
    const sec = Math.max(0, (T0 + (cue.at + 8) * 1000 - recStart) / 1000);
    try { execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(sec), "-i", mp4, "-frames:v", "1", join(framesDir, `${cue.id}.png`)]); } catch { /* past the end */ }
  }
  const tr = (await api(`/${tester.botId}/transcript`)).body;
  const utt = Array.isArray(tr) ? tr : (tr?.results ?? []);
  const byYui = utt.filter((u) => (u.speaker_name ?? "") === botName);
  row("tester recording", "PASS", TESTER_RECORDING === "mp4" ? `${mp4} · frames → ${framesDir}` : `${mp4} (audio only: no tile frames this run)`);
  row("room heard the character (vendor transcript)", byYui.length ? "PASS" : "FAIL", `${byYui.length}/${utt.length} utterances by ${botName}: ${byYui.slice(0, 3).map((u) => JSON.stringify(u.transcription?.transcript ?? u.transcription).slice(0, 60)).join(" / ")}`);
  writeFileSync(join(dir, "report.json"), JSON.stringify({ meetingUrl: url, yui: yui.botId, tester: tester.botId, engine, proactivity, T0, results, audio: audio.map((a) => ({ ...a, quality: a.quality && { ...a.quality } })), preflight: { ...pre, worker: preWorker, page: prePage }, heartbeat: beat, pageEvents: finalPage.pageEvents, transcript: utt, recording: rec, relay: relayStat, host: hostSamples }, null, 2));
  console.log(`\nreport → ${join(dir, "report.json")}`);
} else {
  row("tester recording", "FAIL", "no recording from the Tester");
}
process.exit(0);
