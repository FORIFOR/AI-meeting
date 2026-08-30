/**
 * P0-2 soak / E2E harness: drives the REAL web app in real (headless) Chrome with a fake microphone
 * for N minutes against a running stack (web 5173 + token-broker 8787 + agent 8788) and one engine.
 *
 *   node apps/web/scripts/soak-browser.mjs --engine openai|google|local --minutes 30 [--wav <file|dir>]
 *        [--character yui] [--mode free_talk|interview|english_lesson] [--base http://localhost:5173]
 *        [--broker http://localhost:8787] [--agent ws://localhost:8788] [--out docs/reports/soak]
 *
 * Cloud engines need real credentials in services/token-broker/.env; without them the run is reported as
 * BLOCKED_BY_OPENAI_KEY / BLOCKED_BY_GEMINI_KEY (exit code 2) — never a fake PASS.
 * Verdict PASS only if the session survived the whole duration, ≥ 80 % of utterances were answered and no
 * fatal error/toast occurred.
 */
import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeSoakWav, writeWav } from "./lib/make-soak-wav.mjs";

const args = parseArgs(process.argv.slice(2));
const engine = args.engine ?? "local";
const minutes = Number(args.minutes ?? 30);
const character = args.character ?? "yui";
const mode = args.mode ?? "free_talk";
const base = args.base ?? "http://localhost:5173";
const brokerUrl = args.broker ?? "http://localhost:8787";
const agentUrl = args.agent ?? "ws://localhost:8788";
const outDir = resolve(args.out ?? "docs/reports/soak");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const jsonPath = join(outDir, `${engine}-${stamp}.json`);
const mdPath = join(outDir, `${engine}-${stamp}.md`);
const chrome = args.chrome ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engineKeyMap = { openai: "openai", google: "google", local: "local" };
if (!engineKeyMap[engine]) fail(`unknown engine ${engine}`);

// ---- 0. Preflight: is the engine actually available? --------------------------------------
const report = { engine, minutes, character, mode, startedAt: new Date().toISOString(), verdict: "UNKNOWN", blocked: null, preflight: {}, timeline: null, samples: [], pills: [], transcript: [], toasts: [], consoleErrors: [], pageErrors: [], httpErrors: [], reconnects: [], hudLast: null, result: null, summary: null };
report.preflight = await preflight(engine, brokerUrl, agentUrl);
if (report.preflight.blocked) {
  report.verdict = "BLOCKED";
  report.blocked = report.preflight.blocked;
  finish(2);
}

// ---- 1. Fake microphone WAV -----------------------------------------------------------------
let wav = args.wav;
if (!wav || (existsSync(wav) && statSync(wav).isDirectory())) {
  const dir = wav ?? join(tmpdir(), "rcai-soak");
  mkdirSync(dir, { recursive: true });
  wav = join(dir, `soak-${minutes}m.wav`);
  if (!existsSync(wav) || !existsSync(wav.replace(/\.wav$/, ".timeline.json"))) {
    console.log(`generating ${wav} (${minutes} min of Japanese utterances via say)…`);
    const built = makeSoakWav({ minutes });
    writeWav(wav, built.samples);
    writeFileSync(wav.replace(/\.wav$/, ".timeline.json"), JSON.stringify({ seconds: built.seconds, timeline: built.timeline }, null, 2));
  }
}
wav = resolve(wav);
const timelinePath = wav.replace(/\.wav$/, ".timeline.json");
report.timeline = existsSync(timelinePath) ? JSON.parse(readFileSync(timelinePath, "utf8")) : null;
report.wav = wav;

// ---- 2. Browser ------------------------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,860",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, // loops by default
  ],
  defaultViewport: { width: 1280, height: 860 },
});
report.chrome = await browser.version();
const page = await browser.newPage();
const t0 = Date.now();
const now = () => Date.now() - t0;
page.on("console", (m) => {
  const text = m.text();
  if (/reconnect|connectionstate|goAway|session_ready|ice /i.test(text)) report.reconnects.push({ t: now(), text: text.slice(0, 300) });
  if (m.type() === "error" || /error|BLOCKED/i.test(text)) report.consoleErrors.push({ t: now(), text: text.slice(0, 300) });
});
page.on("pageerror", (e) => report.pageErrors.push({ t: now(), text: String(e).slice(0, 300) }));
page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) report.httpErrors.push({ t: now(), status: r.status(), url: r.url() }); });

await page.evaluateOnNewDocument((settings) => { localStorage.setItem("rcai.settings.v1", JSON.stringify(settings)); }, {
  brokerUrl, agentUrl, engine, autoPolicy: engine === "local" ? "offline" : "quality_first", advanced: {},
  privacyMode: engine === "local" ? "strict_local" : "default", showHud: true, characterId: character, cameraOn: false, captionsOn: true,
});
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await sleep(1500);

// ---- 3. Home → product → Setup → Start -----------------------------------------------------------
const productIndex = { free_talk: 0, interview: 1, english_lesson: 2 }[mode] ?? 0;
const products = await page.$$("button.product");
const disabled = await page.evaluate((i) => { const b = document.querySelectorAll("button.product")[i]; return b ? { disabled: b.disabled, title: b.title } : { disabled: true, title: "no product button" }; }, productIndex);
if (disabled.disabled) { report.verdict = "FAIL"; report.failReason = `product disabled: ${disabled.title}`; await browser.close(); finish(1); }
await products[productIndex].click();
// Modes with a single param-less persona (free talk) skip the Setup screen and start immediately.
await page.waitForSelector(".btn--primary.btn--lg, .pill", { timeout: 30000 });
if (await page.$(".btn--primary.btn--lg")) await page.click(".btn--primary.btn--lg");
await page.waitForSelector(".pill", { timeout: 30000 });
const sessionStart = now();
report.sessionStartMs = sessionStart;

// ---- 4. Poll loop --------------------------------------------------------------------------------
const durationMs = minutes * 60 * 1000;
let lastPill = "";
const seen = new Set();
const partialUser = { text: "", at: 0 };
let speakingStart = null;
let survived = true;
let failReason = null;
let lastSpeakingEnd = sessionStart;
let longestNoSpeechGap = 0;
while (now() - sessionStart < durationMs) {
  let s;
  try {
    s = await page.evaluate(() => ({
      pill: document.querySelector(".pill")?.textContent?.trim() ?? "",
      captions: [...document.querySelectorAll(".caption")].map((c) => {
        const who = c.querySelector(".caption__who")?.textContent?.trim() ?? "";
        return { who, text: (c.textContent ?? "").trim().replace(/^You|^AI/, "").trim(), partial: c.classList.contains("caption--partial") };
      }),
      hud: document.querySelector(".hud")?.innerText ?? null,
      toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent?.trim()),
      stageGone: !document.querySelector(".stage"),
    }));
  } catch (e) {
    survived = false; failReason = `page evaluate failed: ${String(e).slice(0, 200)}`; break;
  }
  const t = now() - sessionStart;
  if (s.stageGone) { survived = false; failReason = "session screen disappeared"; break; }
  if (s.pill !== lastPill) {
    report.pills.push({ t, pill: s.pill });
    const key = s.pill.split(" ")[0];
    if (key === "Speaking") { speakingStart = t; longestNoSpeechGap = Math.max(longestNoSpeechGap, t - lastSpeakingEnd); }
    else if (lastPill.startsWith("Speaking")) lastSpeakingEnd = t;
    lastPill = s.pill;
  }
  for (const c of s.captions) {
    if (!c.text) continue;
    if (c.partial) { if (c.who === "You") { partialUser.text = c.text; partialUser.at = t; } continue; }
    const key = `${c.who}|${c.text}`;
    if (!seen.has(key)) { seen.add(key); report.transcript.push({ t, role: c.who === "You" ? "user" : "assistant", text: c.text }); }
  }
  for (const tt of s.toasts) if (tt && !report.toasts.some((x) => x.text === tt)) report.toasts.push({ t, text: tt });
  if (s.hud) report.hudLast = s.hud;
  if (report.samples.length === 0 || t - report.samples[report.samples.length - 1].t >= 30000) report.samples.push({ t, pill: s.pill, hud: parseHud(s.hud), transcript: report.transcript.length });
  if (s.toasts.some((x) => /fatal|BLOCKED_BY|failed|切断|disconnected/i.test(x ?? ""))) {
    // A BLOCKED/fatal toast means the engine is unusable: fail fast instead of burning minutes.
    survived = false; failReason = `fatal toast: ${s.toasts.join(" | ")}`; break;
  }
  await sleep(500);
}
const elapsedMs = now() - sessionStart;
if (survived && lastPill.startsWith("Speaking")) longestNoSpeechGap = Math.max(longestNoSpeechGap, 0);
else if (survived) longestNoSpeechGap = Math.max(longestNoSpeechGap, elapsedMs - lastSpeakingEnd);

// ---- 5. End → Result -------------------------------------------------------------------------
try {
  await page.click(".btn--danger");
  await page.waitForSelector(".result", { timeout: 90000 });
  await sleep(1000);
  report.result = await page.evaluate(() => ({ overall: document.querySelector(".score--overall .score__value")?.textContent ?? null }));
} catch (e) {
  report.resultError = String(e).slice(0, 200);
}
await browser.close();

// ---- 6. Summary + verdict -------------------------------------------------------------------------
const hud = parseHud(report.hudLast);
const userTurns = report.transcript.filter((x) => x.role === "user");
const aiTurns = report.transcript.filter((x) => x.role === "assistant");
let answered = 0;
for (let i = 0; i < userTurns.length; i++) {
  const next = userTurns[i + 1]?.t ?? Infinity;
  if (aiTurns.some((a) => a.t >= userTurns[i].t && a.t <= next + 15000)) answered++;
}
const expectedUtterances = report.timeline ? report.timeline.timeline.filter((u) => u.startSec * 1000 <= elapsedMs % (report.timeline.seconds * 1000) || elapsedMs > report.timeline.seconds * 1000).length : null;
const replyLens = aiTurns.map((a) => a.text.length);
const speakingPills = report.pills.filter((p) => p.pill.startsWith("Speaking")).length;
report.summary = {
  elapsedMs, survived, failReason,
  userUtterancesHeard: userTurns.length, assistantTurns: aiTurns.length, answered, answeredRatio: userTurns.length ? answered / userTurns.length : 0,
  expectedUtterancesFromWav: expectedUtterances, speakingEpisodes: speakingPills,
  turnLatency: hud.turn, bargeInStop: hud.bargeIn, listeningReact: hud.listening, mouthStop: hud.mouthStop,
  reconnectEvents: report.reconnects.length, toasts: report.toasts.length, consoleErrors: report.consoleErrors.length, pageErrors: report.pageErrors.length, httpErrors: report.httpErrors.length,
  longestNoAssistantSpeechMs: longestNoSpeechGap,
  replyChars: replyLens.length ? { min: Math.min(...replyLens), p50: pct(replyLens, 50), max: Math.max(...replyLens), avg: Math.round(replyLens.reduce((a, b) => a + b, 0) / replyLens.length) } : null,
  resultOverall: report.result?.overall ?? null,
};
const fullDuration = elapsedMs >= durationMs - 2000;
report.verdict = survived && fullDuration && report.summary.answeredRatio >= 0.8 && report.pageErrors.length === 0 && !report.toasts.some((x) => /fatal|BLOCKED_BY/i.test(x.text)) ? "PASS" : "FAIL";
if (report.verdict === "FAIL" && !failReason) report.failReason = !fullDuration ? "did not reach full duration" : report.summary.answeredRatio < 0.8 ? `answered ratio ${report.summary.answeredRatio.toFixed(2)} < 0.8` : "errors present";
finish(report.verdict === "PASS" ? 0 : 1);

// ---- helpers ------------------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; out[k] = v; }
  return out;
}
async function preflight(engine, brokerUrl, agentUrl) {
  const out = { broker: null, agent: null, blocked: null };
  try { out.broker = await (await fetch(`${brokerUrl}/health`, { signal: AbortSignal.timeout(4000) })).json(); } catch { out.broker = null; }
  try { out.agent = await (await fetch(`${agentUrl.replace(/^ws/, "http")}/health`, { signal: AbortSignal.timeout(4000) })).json(); } catch { out.agent = null; }
  if (engine === "openai" && !out.broker?.providers?.openai) out.blocked = out.broker ? "BLOCKED_BY_OPENAI_KEY" : "BLOCKED_BY_BROKER_OFFLINE";
  if (engine === "google" && !out.broker?.providers?.google) out.blocked = out.broker ? "BLOCKED_BY_GEMINI_KEY" : "BLOCKED_BY_BROKER_OFFLINE";
  if (engine === "local" && !out.agent?.ok) out.blocked = "BLOCKED_BY_AGENT_OFFLINE";
  return out;
}
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function parseHud(text) {
  const out = { turn: null, bargeIn: null, listening: null, mouthStop: null };
  if (!text) return out;
  for (const line of text.split("\n")) {
    const n = /n=(\d+)/.exec(line)?.[1];
    if (/^turn p50/.test(line)) { const m = /([\d–-]+)\s*\/\s*([\d–-]+)\s*ms/.exec(line); out.turn = { p50: num(m?.[1]), p95: num(m?.[2]), n: num(n) }; }
    else if (/barge-in/.test(line)) out.bargeIn = { ms: num(/([\d–-]+)\s*ms/.exec(line)?.[1]), n: num(n) };
    else if (/^→ listening/.test(line)) out.listening = { ms: num(/([\d–-]+)\s*ms/.exec(line)?.[1]), n: num(n) };
    else if (/^mouth stop/.test(line)) out.mouthStop = { ms: num(/([\d–-]+)\s*ms/.exec(line)?.[1]), n: num(n) };
  }
  return out;
}
function pct(values, p) { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; }
function fail(msg) { console.error(msg); process.exit(1); }
function finish(code) {
  report.endedAt = new Date().toISOString();
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, renderMd(report));
  console.log(readFileSync(mdPath, "utf8"));
  console.log(`\njson: ${jsonPath}`);
  process.exit(code);
}
function renderMd(r) {
  const s = r.summary;
  const lines = [`# Soak ${r.engine} — ${r.verdict}${r.blocked ? ` (${r.blocked})` : ""}`, ``, `- started: ${r.startedAt} · requested: ${r.minutes} min · character: ${r.character} · mode: ${r.mode}`, `- preflight: broker=${r.preflight.broker ? "up" : "down"} agent=${r.preflight.agent ? "up" : "down"}${r.preflight.broker ? ` providers=${JSON.stringify(r.preflight.broker.providers)}` : ""}`];
  if (r.blocked) { lines.push(``, `Engine unavailable: **${r.blocked}** — set the credential in services/token-broker/.env (see services/token-broker/README.md) and rerun.`); return lines.join("\n"); }
  if (!s) { lines.push(`- failed before the session started: ${r.failReason ?? "?"}`); return lines.join("\n"); }
  lines.push(``, `| metric | value |`, `|---|---|`,
    `| session survived | ${s.survived ? "yes" : `no — ${s.failReason}`} (${(s.elapsedMs / 60000).toFixed(1)} min) |`,
    `| user utterances heard (final captions) | ${s.userUtterancesHeard}${s.expectedUtterancesFromWav != null ? ` / ${s.expectedUtterancesFromWav} in WAV` : ""} |`,
    `| assistant turns / answered ratio | ${s.assistantTurns} / ${(s.answeredRatio * 100).toFixed(0)} % |`,
    `| turn latency p50 / p95 (HUD) | ${s.turnLatency?.p50 ?? "–"} / ${s.turnLatency?.p95 ?? "–"} ms (n=${s.turnLatency?.n ?? 0}) |`,
    `| barge-in → audio stop | ${s.bargeInStop?.ms ?? "–"} ms (n=${s.bargeInStop?.n ?? 0}) |`,
    `| speech detected → LISTENING | ${s.listeningReact?.ms ?? "–"} ms (n=${s.listeningReact?.n ?? 0}) |`,
    `| audio stop → mouth closed | ${s.mouthStop?.ms ?? "–"} ms (n=${s.mouthStop?.n ?? 0}) |`,
    `| speaking episodes | ${s.speakingEpisodes} |`,
    `| longest gap without assistant speech | ${(s.longestNoAssistantSpeechMs / 1000).toFixed(1)} s |`,
    `| reconnect events (console) | ${s.reconnectEvents} |`,
    `| toasts / console errors / page errors / http≥400 | ${s.toasts} / ${s.consoleErrors} / ${s.pageErrors} / ${s.httpErrors} |`,
    `| assistant reply length (chars) min/p50/avg/max | ${s.replyChars ? `${s.replyChars.min}/${s.replyChars.p50}/${s.replyChars.avg}/${s.replyChars.max}` : "–"} |`,
    `| result screen overall | ${s.resultOverall ?? "–"} |`);
  if (r.failReason) lines.push(``, `Fail reason: ${r.failReason}`);
  if (r.toasts.length) lines.push(``, `Toasts: ${r.toasts.map((t) => `[${(t.t / 1000).toFixed(0)}s] ${t.text}`).join(" · ")}`);
  lines.push(``, `Last exchanges:`, ...r.transcript.slice(-6).map((x) => `- [${(x.t / 1000).toFixed(0)}s] ${x.role === "user" ? "You" : "AI"}: ${x.text.slice(0, 120)}`));
  return lines.join("\n");
}
