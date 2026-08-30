/**
 * Gate 7 / Gate A-D evidence runner: drives the real web app in real (headless) Chrome with a
 * fake microphone (WAV) against the running local stack (agent 8788 + broker 8787 + web 5173).
 * Usage: node apps/web/scripts/e2e-browser.mjs <mic.wav> [baseUrl]
 */
import puppeteer from "../../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
// Variant of apps/web/scripts/e2e-browser.mjs that targets a specific agent (AGENT_WS) and output dir (OUT_DIR).
const AGENT_WS = process.env.AGENT_WS ?? "ws://localhost:8788";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const wav = resolve(process.argv[2] ?? "mic.wav");
const base = process.argv[3] ?? "http://localhost:5173";
const outDir = resolve(process.cwd(), process.env.OUT_DIR ?? "docs/reports/img");
mkdirSync(outDir, { recursive: true });
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => Date.now() - t0;

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: [
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--window-size=1280,860",
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`,
  ],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const log = { chrome: await browser.version(), toasts: [], errors: [], console: [], pills: [], captions: [], hud: null, result: null, screenshots: [] };
page.on("console", (m) => { const t = m.text(); if (m.type() === "error" || /error|BLOCKED/i.test(t)) log.console.push(`[${now()}] ${m.type()}: ${t.slice(0, 300)}`); });
page.on("pageerror", (e) => log.errors.push(`[${now()}] ${String(e).slice(0, 300)}`));
page.on("response", (r) => { if (r.status() >= 400) log.errors.push(`[${now()}] ${r.status()} ${r.url()}`); });

await page.evaluateOnNewDocument((agentUrl) => {
  localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl, engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: true, characterId: "yui", cameraOn: false, captionsOn: true }));
}, AGENT_WS);
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await sleep(1500);
const shot = async (name) => { const p = `${outDir}/${name}.png`; await page.screenshot({ path: p }); log.screenshots.push(name); };
await shot("gate7-home");

// Home → Interview practice
const products = await page.$$("button.product");
const homeState = await page.evaluate(() => ({ strict: document.querySelector(".switch")?.getAttribute("aria-pressed"), meta: document.querySelector(".radio__meta")?.textContent, blocked: document.querySelector(".err")?.textContent ?? null }));
log.home = { ...homeState, products: await page.evaluate(() => [...document.querySelectorAll("button.product")].map((b) => ({ text: b.textContent?.trim().slice(0, 30), disabled: b.disabled, title: b.title }))) };
console.log("home:", JSON.stringify(log.home), "console:", JSON.stringify(log.console.slice(0, 5)), "errors:", JSON.stringify(log.errors.slice(0, 5)));
await products[1].click(); // 面接練習
await page.waitForSelector(".btn--primary.btn--lg", { timeout: 15000 });
await shot("gate7-setup");
log.setup = await page.evaluate(() => ({ chips: [...document.querySelectorAll(".chip")].map((c) => c.textContent?.trim()), selects: [...document.querySelectorAll("select.select")].map((s) => s.value) }));
await page.click(".btn--primary.btn--lg");

// Session: poll pill + captions
await page.waitForSelector(".pill", { timeout: 30000 });
const sessionStart = now();
let lastPill = "";
let lastCaps = "";
const deadline = sessionStart + 48000;
let shotsTaken = { listening: false, speaking: false, thinking: false };
while (now() < deadline) {
  const s = await page.evaluate(() => ({
    pill: document.querySelector(".pill")?.textContent?.trim() ?? "",
    caps: [...document.querySelectorAll(".caption")].map((c) => c.textContent?.trim()).join(" | "),
    hud: document.querySelector(".hud")?.innerText ?? null,
    toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent?.trim()),
  }));
  for (const t of s.toasts) if (!log.toasts.includes(t)) log.toasts.push(t);
  if (s.pill !== lastPill) { log.pills.push({ t: now() - sessionStart, pill: s.pill }); lastPill = s.pill; }
  if (s.caps !== lastCaps) { log.captions.push({ t: now() - sessionStart, caps: s.caps }); lastCaps = s.caps; }
  if (s.hud) log.hud = s.hud;
  const key = /Listening/i.test(s.pill) ? "listening" : /Speaking/i.test(s.pill) ? "speaking" : /Thinking/i.test(s.pill) ? "thinking" : null;
  if (key && !shotsTaken[key]) { shotsTaken[key] = true; await shot(`gate7-session-${key}`); }
  await sleep(100);
}
await shot("gate7-session-end");
// End → Result
await page.click(".btn--danger");
try {
  await page.waitForSelector(".result", { timeout: 60000 });
  await sleep(1500);
  log.result = await page.evaluate(() => ({ overall: document.querySelector(".score--overall .score__value")?.textContent, text: document.querySelector(".result")?.innerText?.slice(0, 2500) }));
  await shot("gate7-result");
} catch (e) {
  log.errors.push(`result screen: ${String(e).slice(0, 200)}`);
}
await browser.close();
writeFileSync(`${outDir}/gate7-results.json`, JSON.stringify(log, null, 2));
console.log(JSON.stringify({ toasts: log.toasts, pills: log.pills, captions: log.captions.slice(-6), hud: log.hud, result: log.result?.overall, errors: log.errors, console: log.console.slice(0, 15), home: log.home, setup: log.setup }, null, 2));
