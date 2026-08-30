/**
 * P0-4 acoustic Reality Gate with REAL audio devices (no fake mic): routes both the character's
 * voice and a "user" WAV through the BlackHole loopback device so the browser's mic hears
 * everything the speaker plays. Checks that (1) the AI does not treat its own voice as user speech
 * (AEC / self-trigger), (2) a user utterance played during AI speech still triggers barge-in.
 * Requires: BlackHole 2ch, SwitchAudioSource, the local stack (agent+broker+web) running.
 * Usage: node apps/web/scripts/acoustic-gate.mjs <utter1.wav> <utter2.wav> [baseUrl]
 */
import puppeteer from "puppeteer-core";
import { execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [wav1, wav2] = [resolve(process.argv[2]), resolve(process.argv[3])];
const base = process.argv[4] ?? "http://localhost:5173";
const outDir = resolve(process.cwd(), "docs/reports/img");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => Date.now() - t0;

const prevOut = execSync("SwitchAudioSource -c -t output", { encoding: "utf8" }).trim();
const prevIn = execSync("SwitchAudioSource -c -t input", { encoding: "utf8" }).trim();
execSync('SwitchAudioSource -t output -s "BlackHole 2ch"');
execSync('SwitchAudioSource -t input -s "BlackHole 2ch"');
const restore = () => {
  try { execSync(`SwitchAudioSource -t output -s "${prevOut}"`); execSync(`SwitchAudioSource -t input -s "${prevIn}"`); } catch {}
};
process.on("exit", restore);

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--window-size=1280,860"],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const log = { chrome: await browser.version(), devices: null, pills: [], captions: [], hud: null, playing: [], selfTriggers: [], bargeIn: null, errors: [] };
page.on("pageerror", (e) => log.errors.push(`[${now()}] ${String(e).slice(0, 200)}`));

// Discover BlackHole device ids from a throwaway page (labels need a granted permission first).
await page.goto(base, { waitUntil: "domcontentloaded" });
log.devices = await page.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
  const list = await navigator.mediaDevices.enumerateDevices();
  return list.filter((d) => d.kind.startsWith("audio")).map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId }));
});
const inId = log.devices.find((d) => d.kind === "audioinput" && /BlackHole/i.test(d.label))?.id;
const outId = log.devices.find((d) => d.kind === "audiooutput" && /BlackHole/i.test(d.label))?.id;
if (!inId) { console.log("BLOCKED_BY_NO_LOOPBACK_DEVICE: BlackHole input not found", log.devices); await browser.close(); process.exit(2); }

await page.evaluateOnNewDocument((inId, outId) => {
  localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: true, characterId: "yui", cameraOn: false, captionsOn: true, inputDeviceId: inId, outputDeviceId: outId }));
}, inId, outId);
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll("button.product")].some((b) => !b.disabled), { timeout: 20000 }).catch(async () => {
  console.log("home state:", JSON.stringify(await page.evaluate(() => ({ err: document.querySelector(".err")?.textContent, products: [...document.querySelectorAll("button.product")].map((b) => ({ t: b.textContent?.slice(0, 20), d: b.disabled, title: b.title })) }))));
  await browser.close(); restore(); process.exit(1);
});
await sleep(300);
const freeTalk = (await page.$$("button.product"))[0];
await freeTalk.click(); // Free Talk (goes straight to the session; other products show a Setup screen first)
await page.waitForSelector(".btn--primary.btn--lg, .pill", { timeout: 20000 });
if (await page.$(".btn--primary.btn--lg")) await page.click(".btn--primary.btn--lg");
await page.waitForSelector(".pill", { timeout: 30000 });
const sessionStart = now();

let lastPill = "", lastCaps = "";
let playingUntil = 0;
const play = (wav, label) => {
  const p = spawn("afplay", [wav]);
  const start = now();
  log.playing.push({ label, start });
  playingUntil = Infinity;
  p.on("exit", () => { playingUntil = now(); log.playing[log.playing.length - 1].end = now(); });
  return p;
};
const poll = async () => {
  const s = await page.evaluate(() => ({
    pill: document.querySelector(".pill")?.textContent?.trim() ?? "",
    caps: [...document.querySelectorAll(".caption")].map((c) => c.textContent?.trim()).join(" | "),
    hud: document.querySelector(".hud")?.innerText ?? null,
  }));
  if (s.pill !== lastPill) {
    const t = now() - sessionStart;
    log.pills.push({ t, pill: s.pill });
    // A transition into Listening while nothing is being played into the loopback = the AI heard itself.
    if (/Listening/.test(s.pill) && !(playingUntil === Infinity || now() - playingUntil < 800)) {
      if (/Speaking/.test(lastPill)) log.selfTriggers.push({ t, from: lastPill });
    }
    lastPill = s.pill;
  }
  if (s.caps !== lastCaps) { log.captions.push({ t: now() - sessionStart, caps: s.caps.slice(-400) }); lastCaps = s.caps; }
  if (s.hud) log.hud = s.hud;
  return s;
};

// Phase 1: let the opening line + one answer play with nothing else on the loopback (self-trigger check).
const phase1End = now() + 14000;
while (now() < phase1End) { await poll(); await sleep(100); }
// Phase 2: user utterance 1 (through the loopback), wait for the answer.
play(wav1, "utter1");
const phase2End = now() + 14000;
while (now() < phase2End) { await poll(); await sleep(100); }
// Phase 3: ask again (utter1) and, as soon as the AI starts speaking, play utterance 2 → barge-in must happen.
play(wav1, "utter1-again");
let waited = 0;
let sawSpeaking = false;
while (waited < 25000) { const s = await poll(); if (/Speaking/.test(s.pill) && now() - sessionStart > (log.pills.at(-1)?.t ?? 0)) { sawSpeaking = true; break; } await sleep(50); waited += 50; }
if (sawSpeaking) {
  await sleep(400); // let the answer be audible before interrupting
  const tBarge = now() - sessionStart;
  play(wav2, "utter2-bargein");
  let ok = null;
  for (let i = 0; i < 100; i++) { const s = await poll(); if (/Listening/.test(s.pill)) { ok = now() - sessionStart - tBarge; break; } await sleep(50); }
  log.bargeIn = { startedAt: tBarge, listeningAfterMs: ok };
} else {
  log.bargeIn = { error: "AI never started speaking after utter1-again" };
}
const phase4End = now() + 12000;
while (now() < phase4End) { await poll(); await sleep(100); }
await page.screenshot({ path: `${outDir}/p0-4-acoustic.png` });
await page.click(".btn--danger").catch(() => {});
await sleep(1500);
await browser.close();
restore();
writeFileSync(`${outDir}/p0-4-acoustic-results.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify({ selfTriggers: log.selfTriggers, bargeIn: log.bargeIn, pills: log.pills.map((p) => [p.t, p.pill.split(" ")[0]]), playing: log.playing, hud: log.hud, lastCaps: log.captions.at(-1)?.caps, errors: log.errors }, null, 2));
