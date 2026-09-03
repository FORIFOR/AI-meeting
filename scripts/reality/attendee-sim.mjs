/**
 * The whole meeting path, without a meeting.
 *
 *   real recording → a stand-in that speaks Attendee's API and websocket protocol → the real broker,
 *   the real relay, the real bot page in a real browser, the real agent → the character's audio,
 *   measured where Attendee would have received it.
 *
 * Everything between the broker and the character is production code. What is simulated is the vendor:
 * its REST call, its three sockets, and the browser it launches for the voice agent. That is the one
 * part a live call would exercise that this cannot — but it is also the part that has never been the
 * problem. What has been the problem is everything downstream, and none of it can be reached without a
 * meeting until now.
 *
 *   AUDIO=<wav> FRAMES=<dir> pnpm reality:attendee:sim
 */
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { loadEnv } from "./lib.mjs";

const require = createRequire("/Users/horioshuuhei/Projects/AI-meeting/services/agent/package.json");
const WebSocket = require("ws");
const puppeteerRequire = createRequire("/Users/horioshuuhei/Projects/AI-meeting/apps/web/package.json");
const puppeteer = puppeteerRequire("puppeteer-core");

const env = loadEnv();
const broker = process.env.BROKER_URL ?? "http://localhost:8787";
const PORT = Number(process.env.SIM_PORT ?? 8799);
const AUDIO = process.env.AUDIO;
const FRAMES = process.env.FRAMES;
const SECONDS = Number(process.env.SECONDS ?? 75);
const PARTICIPANT = "participant_sim_a";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

if (!AUDIO || !fs.existsSync(AUDIO)) { console.log(`BLOCKED_BY_AUDIO: set AUDIO to a 16 kHz mono wav (got ${AUDIO})`); process.exit(2); }
const frameFiles = FRAMES && fs.existsSync(FRAMES) ? fs.readdirSync(FRAMES).filter((f) => f.endsWith(".jpg")).sort().map((f) => path.join(FRAMES, f)) : [];

// ---- the recording -----------------------------------------------------------------------------
const wav = fs.readFileSync(AUDIO);
const dataAt = wav.indexOf(Buffer.from("data")) + 8;
const pcm = wav.subarray(dataAt);
/**
 * 100 ms per message, not 20. At 20 ms this stand-in spends more time in JSON and base64 than in the
 * socket and delivers a quarter of what it should — which looks exactly like a product that drops
 * audio. A vendor sends larger frames anyway.
 */
const CHUNK_MS = 100;
const BYTES_PER_CHUNK = (16000 * 2 * CHUNK_MS) / 1000;

// ---- what the stand-in observed ----------------------------------------------------------------
const seen = {
  createdBot: null, sockets: { mixed: 0, participantAudio: 0, participantVideo: 0 },
  botOutputChunks: 0, botOutputBytes: 0, botOutputFirstAt: null,
  pageErrors: [], pageLogs: [], beats: [],
};
const t0 = Date.now();

// ---- Attendee's REST surface -------------------------------------------------------------------
let onBotCreated = () => {};
const http = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method === "POST" && req.url === "/api/v1/bots") {
      const payload = JSON.parse(body || "{}");
      seen.createdBot = payload;
      const id = `bot_sim_${Date.now().toString(36)}`;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, state: "joining" }));
      setTimeout(() => onBotCreated(id, payload), 50);
      return;
    }
    if (req.method === "POST" && /\/api\/v1\/bots\/[^/]+\/leave$/.test(req.url ?? "")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404).end("{}");
  });
});
await new Promise((r) => http.listen(PORT, r));
console.log(`stand-in Attendee on http://127.0.0.1:${PORT}`);

// ---- drive the real flow -----------------------------------------------------------------------
const created = await (await fetch(`${broker}/api/meeting/attendee/bots`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    // Any platform the connector claims to carry: the stand-in does not care, but the broker and the
    // page both derive behaviour from the URL, and Zoom has never been exercised at all.
    meetingUrl: process.env.MEET_URL ?? "https://meet.google.com/sim-ulat-ion",
    botName: env.RECALL_BOT_NAME ?? "Yui",
    botPageQuery: {
      engine: process.env.ENGINE ?? "local",
      character: "yui", name: env.RECALL_BOT_NAME ?? "Yui", language: "ja-JP",
      proactivity: process.env.PROACTIVITY ?? "open",
      vision: process.env.VISION ?? "cues",
      // The live harness has the vendor capture the page's speaker; measuring the socket path here
      // would pass a page the meeting never hears. OUTBOUND=socket to exercise the other one.
      outbound: process.env.OUTBOUND ?? "page",
    },
  }),
})).json();
if (!created.botId) { console.log("FAIL: broker did not create a bot:", JSON.stringify(created).slice(0, 300)); process.exit(1); }
console.log(`meeting url ${process.env.MEET_URL ?? "https://meet.google.com/sim-ulat-ion"}`);
console.log(`broker created ${created.botId}  page=${created.botPageUrl ? "yes" : "MISSING"}`);

/**
 * The broker must be pointed at this stand-in, or it just made a real bot on a real vendor and sent it
 * to a meeting that does not exist. That costs money and leaves something running; failing loudly is
 * not enough, so the bot is removed before exiting.
 */
if (!seen.createdBot) {
  console.log(`FAIL: the broker did not call this stand-in — it went to the real Attendee and created ${created.botId}.`);
  console.log(`      Removing it. Start the broker with ATTENDEE_API_BASE_URL=http://127.0.0.1:${PORT} and try again.`);
  await fetch(`${broker}/api/meeting/attendee/bots/${created.botId}/leave`, { method: "POST" }).catch(() => {});
  process.exit(2);
}
const ws = seen.createdBot.websocket_settings;
if (!ws?.audio?.url) { console.log("FAIL: the broker asked for no audio socket"); process.exit(1); }
console.log(`sockets asked for: mixed=${!!ws.audio?.url} perAudio=${!!ws.per_participant_audio?.url} perVideo=${!!ws.per_participant_video?.url}`);

// ---- connect as the vendor ---------------------------------------------------------------------
function open(url, label) {
  return new Promise((resolve) => {
    const s = new WebSocket(url);
    s.on("open", () => { seen.sockets[label]++; resolve(s); });
    s.on("error", (e) => { console.log(`socket ${label} failed: ${String(e).slice(0, 120)}`); resolve(null); });
  });
}
const mixed = await open(ws.audio.url, "mixed");
const perAudio = ws.per_participant_audio?.url ? await open(ws.per_participant_audio.url, "participantAudio") : null;
const perVideo = ws.per_participant_video?.url ? await open(ws.per_participant_video.url, "participantVideo") : null;

// The character's voice comes back on the socket it arrives on. This is the measurement.
mixed?.on("message", (raw) => {
  try {
    const m = JSON.parse(String(raw));
    if (m.trigger === "realtime_audio.bot_output" && m.data?.chunk) {
      seen.botOutputChunks++;
      seen.botOutputBytes += Buffer.from(m.data.chunk, "base64").length;
      seen.botOutputFirstAt ??= Date.now();
    }
  } catch { /* not ours */ }
});

// ---- the browser Attendee would have launched ---------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
/**
 * Attendee captures the page's own speaker output and streams that into the meeting — nothing is sent
 * back over the websocket, deliberately, or the character would be heard twice. So the honest
 * measurement here is what the page actually plays: every buffer that reaches the audio destination,
 * counted before the app loads.
 */
await page.evaluateOnNewDocument(() => {
  const w = window;
  w.__rcaiProbe = { buffers: 0, seconds: 0, firstAt: null, ctxState: null };
  // Every socket the page opens, and what actually moved on it: the fastest way to see which hop is
  // silent when the character is not speaking.
  w.__rcaiProbeSockets = [];
  const NativeWS = WebSocket;
  window.WebSocket = function (url, protocols) {
    const s = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    const rec = { url: String(url).slice(0, 60), sent: 0, got: 0, bytesSent: 0, closed: null };
    w.__rcaiProbeSockets.push(rec);
    const send = s.send.bind(s);
    rec.peak = 0;
    s.send = (d) => {
      rec.sent++;
      rec.bytesSent += d?.byteLength ?? String(d).length;
      // Bytes are not proof of sound: a silent stream is the same size as a loud one.
      if (d && d.byteLength && d.byteLength % 2 === 0) {
        const v = new Int16Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength / 2);
        for (let i = 0; i < v.length; i += 7) if (Math.abs(v[i]) > rec.peak) rec.peak = Math.abs(v[i]);
      }
      return send(d);
    };
    s.addEventListener("message", () => rec.got++);
    s.addEventListener("close", (e) => { rec.closed = e.code; });
    return s;
  };
  window.WebSocket.prototype = NativeWS.prototype;
  Object.assign(window.WebSocket, NativeWS);

  // Count every source that is started, not only ones whose buffer is readable at that instant: the
  // question is whether the page made sound, and a null read there was reporting silence during a run
  // that was audibly speaking.
  // Keep the samples too, not just the count: the point of a voice is what it sounds like, and the
  // only place the character's audio exists on this path is the page's own output.
  w.__rcaiPcm = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    w.__rcaiProbe.buffers++;
    w.__rcaiProbe.seconds += this.buffer?.duration ?? 0;
    w.__rcaiProbe.firstAt ??= Date.now();
    try {
      const b = this.buffer;
      if (b && w.__rcaiPcm.length < 4000) {
        w.__rcaiProbe.rate = b.sampleRate;
        w.__rcaiPcm.push(Array.from(b.getChannelData(0)));
      }
    } catch { /* a source without a readable buffer */ }
    return start.apply(this, args);
  };
});
page.on("pageerror", (e) => seen.pageErrors.push(String(e).slice(0, 200)));
let pageStarted = null;
const started = new Promise((resolve) => (pageStarted = resolve));
page.on("console", (m) => {
  const t = m.text();
  if (/\[rcai:bot\] started/.test(t)) pageStarted?.();
  const beat = t.match(/\[rcai:bot\] (\{.*\})$/);
  if (beat) { try { seen.beats.push({ at: Date.now(), ...JSON.parse(beat[1]) }); } catch { /* not a heartbeat */ } }
  if (!/CORS policy|net::ERR|Failed to load resource/.test(t)) seen.pageLogs.push(`${m.type()}: ${t.slice(0, 220)}`);
});
await page.goto(created.botPageUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("bot page opened");
/**
 * Wait for the page to be in the call before anyone talks. A real bot joins an empty meeting and then
 * people speak; streaming into a page that is still loading measures the harness, not the product.
 */
const ready = await Promise.race([started.then(() => true), new Promise((r) => setTimeout(() => r(false), 90_000))]);
console.log(ready ? `bot page ready after ${((Date.now() - t0) / 1000).toFixed(1)}s` : "bot page never reported ready — streaming anyway");
seen.readyAt = ready ? Date.now() : null;

// ---- stream the recording ------------------------------------------------------------------------
let offset = 0;
const audioTimer = setInterval(() => {
  if (offset >= pcm.length) return;
  const chunk = pcm.subarray(offset, offset + BYTES_PER_CHUNK);
  offset += BYTES_PER_CHUNK;
  const b64 = chunk.toString("base64");
  const stamp = Date.now();
  mixed?.send(JSON.stringify({ trigger: "realtime_audio.mixed", data: { chunk: b64, timestamp_ms: stamp, sample_rate: 16000 } }));
  perAudio?.send(JSON.stringify({ trigger: "realtime_audio.per_participant", data: { participant_uuid: PARTICIPANT, chunk: b64, timestamp_ms: stamp, sample_rate: 16000 } }));
}, CHUNK_MS);

let frameIndex = 0;
const videoTimer = frameFiles.length
  ? setInterval(() => {
      const f = frameFiles[frameIndex++ % frameFiles.length];
      perVideo?.send(JSON.stringify({
        trigger: "realtime_video.per_participant",
        data: { participant_uuid: PARTICIPANT, frame: fs.readFileSync(f).toString("base64"), format: "jpeg", source: "webcam" },
      }));
    }, 500)
  : null;

/**
 * What Attendee's capture would see, twice: as soon as the page is up, and again in the middle of the
 * run. The room's tile is made of these frames; a blurry tile starts here or it does not.
 */
const SHOTS = process.env.SHOTS ? String(process.env.SHOTS).replace(/\/$/, "") : null;
const shoot = async (name) => { if (!SHOTS) return; try { await page.screenshot({ path: `${SHOTS}/${name}.png` }); console.log(`screenshot → ${SHOTS}/${name}.png`); } catch (e) { console.log(`screenshot failed: ${e?.message ?? e}`); } };
await shoot("page-ready");
await new Promise((r) => setTimeout(r, (SECONDS * 1000) / 2));
await shoot("page-mid");
await new Promise((r) => setTimeout(r, (SECONDS * 1000) / 2));
clearInterval(audioTimer);
if (videoTimer) clearInterval(videoTimer);

// ---- what happened --------------------------------------------------------------------------------
const inPage = await page.evaluate(() => ({
  text: document.body.innerText.slice(0, 1800),
  audio: { ...window.__rcaiProbe },
  pcm: window.__rcaiPcm.flat(),
  sockets: window.__rcaiProbeSockets,
})).catch(() => ({ text: "", audio: { buffers: 0, seconds: 0, firstAt: null } }));

const row = (n, ok, d) => console.log(`| ${n} | ${ok ? "PASS" : "FAIL"} | ${d} |`);
console.log(`\n| step | status | detail |\n|---|---|---|`);
row("broker asked for all three sockets", !!ws.audio?.url && !!ws.per_participant_audio?.url && !!ws.per_participant_video?.url, `mixed/${!!ws.audio?.url} audio/${!!ws.per_participant_audio?.url} video/${!!ws.per_participant_video?.url}`);
row("vendor sockets accepted", seen.sockets.mixed + seen.sockets.participantAudio + seen.sockets.participantVideo === 3, JSON.stringify(seen.sockets));
row("voice agent page launched", !!created.botPageUrl, created.botPageUrl ? "opened in a real browser" : "no url");
row("page reached the call", !!seen.readyAt, seen.readyAt ? `ready ${((seen.readyAt - t0) / 1000).toFixed(1)}s after the bot was created` : "never reported started");
row("page ran without errors", seen.pageErrors.length === 0, seen.pageErrors[0] ?? "none");
/**
 * The character's voice, measured where Attendee takes it from: the page's own audio output. The
 * websocket path is checked too, because a page that sent audio *both* ways would be heard twice.
 */
row("character spoke (page audio out)", (inPage.audio?.buffers ?? 0) > 0, `${inPage.audio?.buffers ?? 0} buffers · ${(inPage.audio?.seconds ?? 0).toFixed(1)}s · first at ${inPage.audio?.firstAt ? ((inPage.audio.firstAt - t0) / 1000).toFixed(1) + "s" : "—"}`);
const viaSocket = (process.env.OUTBOUND ?? "page") === "socket";
row(viaSocket ? "and pushed it down the socket" : "and did not also push it back down the socket", viaSocket ? seen.botOutputChunks > 0 : seen.botOutputChunks === 0, `${seen.botOutputChunks} bot_output chunks (${viaSocket ? ">0" : "0"} is correct on this path)`);
const stats = await (await fetch(`${broker}/api/meeting/recall/relay-status/${created.botId}`)).json().catch(() => ({}));
row("relay carried the streams", (stats.received ?? 0) > 0 && (stats.malformed ?? 1) === 0, JSON.stringify(stats));
const last = seen.beats[seen.beats.length - 1] ?? {};
const grew = (field) => seen.beats.some((b, i) => i > 0 && b[field] > seen.beats[i - 1][field]);
console.log(`\n| behaviour | status | detail |\n|---|---|---|`);
row("heard everything it was sent", (last.heard ?? 0) > 0 && last.heard === last.forwarded, `heard ${last.heard ?? 0} · forwarded ${last.forwarded ?? 0}`);
row("transcribed the room", (last.transcripts ?? 0) >= 3, `${last.transcripts ?? 0} utterances`);
row("took a turn", (last.spoke ?? 0) > 0, `${last.spoke ?? 0} frames released to the meeting`);
row("entered a conversation", seen.beats.some((b) => b.engagement !== "PASSIVE"), `states: ${[...new Set(seen.beats.map((b) => b.engagement))].join(" → ")}`);
row("answered more than once", seen.beats.filter((b, i) => i > 0 && b.spoke > seen.beats[i - 1].spoke).length >= 2, `${seen.beats.filter((b, i) => i > 0 && b.spoke > seen.beats[i - 1].spoke).length} separate stretches of speech`);
if (frameFiles.length) {
  row("read the camera", (last.cues ?? 0) > 0 && (last.faces ?? 0) > 0, `${last.cues ?? 0} cues · ${last.faces ?? 0} with a face`);
  row("showed the model only what it should", process.env.VISION === "model" ? (last.shown ?? 0) > 0 : (last.shown ?? 0) === 0, `${last.shown ?? 0} frames to the provider (VISION=${process.env.VISION ?? "cues"})`);
}
/**
 * What the page told the broker, read back the way the live harness reads it. Inside a vendor the
 * console above does not exist; this channel is the only one that does, so it has to carry the same
 * facts — and the render rate, which is what the room's tile is made of.
 */
const session = created.clientToken ? await (await fetch(`${broker}/api/meeting/session/${created.sessionId}`, { headers: { authorization: `Bearer ${created.clientToken}` } })).json().catch(() => ({})) : {};
const reported = session.pageEvents ?? [];
row("page reported to the broker", reported.length > 0 && !!session.pageHeartbeat, `${reported.map((e) => e.type).join(" → ") || "nothing"} · fps=${session.pageHeartbeat?.data?.fps ?? "?"} (SwiftShader, ${last.avatar ?? "?"})`);
void grew;

console.log(`\npage audio raw: ${JSON.stringify(inPage.audio)}`);
console.log(`page sockets: ${JSON.stringify(inPage.sockets ?? [])}`);
console.log(`\npage said: ${inPage.text.replace(/\n+/g, " | ").slice(0, 300)}`);
// Heartbeats are summarised above; what is worth reading here is everything else the page said.
const said = seen.pageLogs.filter((l) => !/\[rcai:bot\] \{/.test(l));
if (said.length) console.log(`page logs (last 30, heartbeats omitted):\n  ${said.slice(-30).join("\n  ")}`);

await fetch(`${broker}/api/meeting/attendee/bots/${created.botId}/leave`, { method: "POST" }).catch(() => {});
await browser.close();
http.close();
process.exit(0);
