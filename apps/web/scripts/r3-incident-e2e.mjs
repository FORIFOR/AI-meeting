import puppeteer from "puppeteer-core";
import { writeFileSync } from "node:fs";
const wav = "/private/tmp/claude-501/-Users-horioshuuhei-Projects-AI-meeting/df9b95fd-bd60-4532-b151-5ddfd28ebb5e/scratchpad/forkR/mic.wav";
const base = "http://localhost:5178";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`, "--window-size=1280,860"],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const log = { errors: [], console: [], pills: [], hud: null, toasts: [], result: null };
page.on("pageerror", (e) => log.errors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") log.console.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8797", agentUrl: "ws://localhost:8794", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "default", showHud: true, characterId: "yui", cameraOn: false, captionsOn: true }));
  localStorage.removeItem("rcai.humangate.v1");
  localStorage.removeItem("rcai.incidents.v1");
});
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll("button.act")].some((b) => !b.disabled), { timeout: 30000 });
await sleep(300);
await (await page.$$("button.act"))[0].click();
await page.waitForSelector(".pill", { timeout: 30000 });
const t0 = Date.now();
let lastPill = "";
const poll = async () => {
  const s = await page.evaluate(() => ({ pill: document.querySelector(".pill")?.textContent?.trim() ?? "", hud: document.querySelector(".hud")?.innerText ?? null, toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent?.trim()) }));
  if (s.pill !== lastPill) { log.pills.push([Date.now() - t0, s.pill.split(" ")[0]]); lastPill = s.pill; }
  if (s.hud) log.hud = s.hud;
  for (const t of s.toasts) if (!log.toasts.includes(t)) log.toasts.push(t);
};
// open the human gate panel + opt in
await page.click(".menu .btn--ghost");
await page.waitForSelector(".menu__panel");
const items = await page.$$(".menu__item");
for (const it of items) { const txt = await it.evaluate((e) => e.textContent); if (txt && txt.includes("評価パネル")) { await it.click(); break; } }
await page.waitForSelector(".gate__incident", { timeout: 10000 });
await page.click(".gate__optin input");
const optChecked = await page.$eval(".gate__optin input", (e) => e.checked);
// wait until the assistant has answered utterance 1 (≈ 4 s silence + 6 s utterance + reply)
let waited = 0; let sawSpeakingAfterUser = false;
while (waited < 30000) { await poll(); if (log.pills.some((p) => p[1] === "Listening") && lastPill.startsWith("Speaking")) { sawSpeakingAfterUser = true; break; } await sleep(100); waited += 100; }
await sleep(1500); await poll();
const tCapture = Date.now() - t0;
await page.click(".gate__incident");
await sleep(600); await poll();
const panelHead = await page.$eval(".gate__head", (e) => e.textContent);
for (let i = 0; i < 70; i++) { await poll(); await sleep(100); } // +7 s: window completes and POSTs
await page.screenshot({ path: "/Users/horioshuuhei/Projects/AI-meeting/docs/reports/img/r3-gate6-incident.png" });
await page.click(".ctl--end");
await page.waitForSelector(".result", { timeout: 60000 });
await sleep(1500);
log.result = await page.evaluate(() => {
  const sections = [...document.querySelectorAll(".section")];
  const rep = sections.find((s) => s.textContent?.includes("セッションレポート"));
  return { report: rep?.innerText?.slice(0, 1500) ?? null, incidentsListed: rep ? rep.querySelectorAll(".gate__entry").length : 0 };
});
await page.screenshot({ path: "/Users/horioshuuhei/Projects/AI-meeting/docs/reports/img/r3-gate7-report.png", fullPage: true });
await browser.close();
log.meta = { optChecked, sawSpeakingAfterUser, tCapture, panelHead };
writeFileSync("/Users/horioshuuhei/Projects/AI-meeting/docs/reports/img/r3-gate6-7-e2e.json", JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
