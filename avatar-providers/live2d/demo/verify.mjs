/**
 * Gate 2/3 evidence runner: drives the demo page in real (headless) Chrome via puppeteer-core,
 * captures screenshots + parameter samples. Usage: node demo/verify.mjs [baseUrl]
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const base = process.argv[2] ?? "http://localhost:5180";
const outDir = resolve(process.cwd(), "../../docs/reports/img");
mkdirSync(outDir, { recursive: true });
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--window-size=1200,800"],
  defaultViewport: { width: 1200, height: 800 },
});
const results = { chrome: await browser.version(), characters: {}, listening: null, lipsync: null, interrupt: null, errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(character) {
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  page.on("response", (r) => { if (r.status() >= 400) consoleErrors.push(`${r.status()} ${r.url()}`); });
  await page.goto(`${base}/?character=${character}`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForFunction(() => window.__rcai && document.getElementById("log")?.textContent.includes("ready:"), { timeout: 60000 });
  await sleep(800);
  const diag = await page.evaluate(() => window.__rcai.provider.diagnostics);
  const canvasInfo = await page.evaluate(() => {
    const c = document.querySelector("#stage canvas");
    if (!c) return null;
    const gl = c.getContext("webgl") || c.getContext("webgl2");
    return { width: c.width, height: c.height, hasGL: Boolean(gl) };
  });
  // Non-blank check: sample pixels from the stage canvas via a 2D readback of the page screenshot region.
  const shot = await page.screenshot({ path: `${outDir}/gate2-${character}-idle.png`, clip: { x: 0, y: 0, width: 480, height: 800 } });
  return { page, diag, canvasInfo, consoleErrors, shotBytes: shot.length };
}

async function pixelStats(page) {
  return page.evaluate(() => {
    const c = document.querySelector("#stage canvas");
    const gl = c.getContext("webgl") || c.getContext("webgl2");
    const w = 64, h = 96;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(Math.floor(c.width / 2 - w / 2), Math.floor(c.height / 2 - h / 2), w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let nonTransparent = 0, sum = 0;
    for (let i = 0; i < buf.length; i += 4) { if (buf[i + 3] > 0) nonTransparent++; sum += buf[i] + buf[i + 1] + buf[i + 2]; }
    return { nonTransparent, total: w * h, meanRGB: sum / (w * h * 3) };
  });
}

try {
  for (const ch of ["yui", "haru", "reina"]) {
    const { page, diag, canvasInfo, consoleErrors } = await open(ch);
    let pixels = null;
    try { pixels = await pixelStats(page); } catch (e) { pixels = { error: String(e) }; }
    results.characters[ch] = { diag, canvasInfo, pixels, consoleErrors: consoleErrors.slice(0, 5) };
    if (ch !== "yui") await page.close();
    else results._page = page;
  }
  const page = results._page;
  delete results._page;

  // (b) LISTENING: head/eye movement across ~2 s.
  await page.click('button[data-ev="user_speech_started"]');
  await sleep(300);
  const p1 = await page.evaluate(() => window.__rcai.provider.getParams());
  await page.screenshot({ path: `${outDir}/gate2-yui-listening-1.png`, clip: { x: 0, y: 0, width: 480, height: 800 } });
  const samples = [];
  for (let i = 0; i < 130; i++) { await sleep(30); samples.push(await page.evaluate(() => { const p = window.__rcai.provider.getParams(); return [p.angleX, p.angleY, p.angleZ, p.eyeBallX, p.eyeLOpen, p.bodyAngleX]; })); }
  const p2 = await page.evaluate(() => window.__rcai.provider.getParams());
  await page.screenshot({ path: `${outDir}/gate2-yui-listening-2.png`, clip: { x: 0, y: 0, width: 480, height: 800 } });
  const state = await page.evaluate(() => window.__rcai.runtime.state);
  const blinks = samples.filter((s) => s[4] < 0.5).length;
  const rangeOf = (i) => Math.max(...samples.map((s) => s[i])) - Math.min(...samples.map((s) => s[i]));
  results.listening = { state, angleYRange: rangeOf(1), angleZRange: rangeOf(2), angleXRange: rangeOf(0), eyeBallXRange: rangeOf(3), bodyXRange: rangeOf(5), blinkFramesSeen: blinks, p1: pick(p1), p2: pick(p2), clip: await page.evaluate(() => window.__rcai.provider.stack.currentClip("idle")?.id) };

  // (c) SPEAKING with real played audio through SpeakerOutput.tap.
  await page.click('button[data-ev="user_speech_ended"]');
  await sleep(200);
  await page.evaluate(() => { window.__rcai.mouthLog.length = 0; });
  await page.click("#btn-audio");
  const mouth = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1300) {
    await sleep(40);
    mouth.push(await page.evaluate(() => { const p = window.__rcai.provider.getParams(); const ls = window.__rcai.provider.lipSync.sample(); return { t: performance.now(), open: p.mouthOpenY, form: p.mouthForm, db: ls.levelDb, ctx: window.__rcai.speaker.context.state, ct: window.__rcai.speaker.context.currentTime }; }));
  }
  await page.screenshot({ path: `${outDir}/gate3-yui-speaking.png`, clip: { x: 0, y: 0, width: 1200, height: 800 } });
  const maxOpen = Math.max(...mouth.map((m) => m.open));
  const openFrames = mouth.filter((m) => m.open > 0.2).length;
  const closedFrames = mouth.filter((m) => m.open < 0.05).length;
  results.lipsync = { audioContextState: mouth[mouth.length - 1]?.ctx, audioClockAdvanced: (mouth[mouth.length - 1]?.ct ?? 0) - (mouth[0]?.ct ?? 0), maxMouthOpenY: maxOpen, framesOpen: openFrames, framesClosed: closedFrames, samples: mouth.length, formRange: [Math.min(...mouth.map((m) => m.form)), Math.max(...mouth.map((m) => m.form))], stateDuring: await page.evaluate(() => window.__rcai.runtime.state) };

  // (d) INTERRUPT while the mouth is visibly open: mouth must be 0 in the same tick.
  await page.waitForFunction(() => window.__rcai.provider.getParams().mouthOpenY > 0.3, { timeout: 1500 }).catch(() => {});
  const interrupt = await page.evaluate(() => {
    const { provider, runtime, speaker } = window.__rcai;
    const before = provider.getParams().mouthOpenY;
    const t0 = performance.now();
    speaker.interrupt();
    runtime.handleEvent({ type: "interrupted" });
    const after = provider.getParams().mouthOpenY;
    const dt = performance.now() - t0;
    return { before, after, ms: dt, state: runtime.state, speaking: provider.stack.isSpeaking, speechClip: provider.stack.currentClip("speech") };
  });
  await sleep(50);
  const afterFrame = await page.evaluate(() => window.__rcai.provider.getParams().mouthOpenY);
  await page.screenshot({ path: `${outDir}/gate3-yui-interrupted.png`, clip: { x: 0, y: 0, width: 1200, height: 800 } });
  const mouthTail = [];
  for (let i = 0; i < 10; i++) { await sleep(50); mouthTail.push(await page.evaluate(() => window.__rcai.provider.getParams().mouthOpenY)); }
  results.interrupt = { ...interrupt, mouthAfter50ms: afterFrame, mouthNext500ms: mouthTail, audioStillScheduled: await page.evaluate(() => window.__rcai.speaker.isPlaying) };
  results.errors = await page.evaluate(() => document.getElementById("log").textContent.split("\n").filter((l) => l.includes("ERROR")).slice(0, 5));
  await page.close();
} catch (e) {
  results.errors.push(String(e?.stack ?? e));
}
await browser.close();
writeFileSync(`${outDir}/gate2-results.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

function pick(p) { return { angleX: +p.angleX.toFixed(2), angleY: +p.angleY.toFixed(2), angleZ: +p.angleZ.toFixed(2), eyeBallX: +p.eyeBallX.toFixed(2), eyeLOpen: +p.eyeLOpen.toFixed(2) }; }
