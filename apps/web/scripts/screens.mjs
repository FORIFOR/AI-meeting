/** Design review: captures Home / Setup / Session / Result in real Chrome. */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
const base = process.argv[2] ?? "http://localhost:5173";
const wav = process.argv[3];
const out = resolve(new URL("../../..", import.meta.url).pathname, "docs/reports/img/ui");
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(wav ? [`--use-file-for-fake-audio-capture=${wav}%noloop`] : [])],
  defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
await page.evaluateOnNewDocument(() => localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true })));
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await sleep(1600);
await page.screenshot({ path: `${out}/01-home.png` });
const acts = await page.$$("button.act");
await acts[0].hover(); await sleep(400);
await page.screenshot({ path: `${out}/01b-home-hover.png` });
// character screen
for (const b of await page.$$("button.btn--ghost")) { const t = await page.evaluate((e) => e.textContent, b); if (t?.includes("相手")) { await b.click(); break; } }
await sleep(900);
await page.screenshot({ path: `${out}/02-character.png` });
for (const b of await page.$$("button.btn")) { const t = await page.evaluate((e) => e.textContent, b); if (t?.includes("この相手")) { await b.click(); break; } }
await sleep(700);
await (await page.$$("button.act"))[0].click();
await page.waitForSelector(".page__actions .btn--primary, .pill", { timeout: 20000 });
await sleep(900);
await page.screenshot({ path: `${out}/03-setup.png` });
if (await page.$(".page__actions .btn--primary")) await page.click(".page__actions .btn--primary");
await page.waitForSelector(".pill", { timeout: 30000 });
// catch each state as it happens
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 42000 && seen.size < 3) {
  const pill = await page.evaluate(() => document.querySelector(".pill")?.textContent ?? "");
  for (const [k, re] of [["04-listening", /Listening/], ["05-thinking", /Thinking/], ["06-speaking", /Speaking/]]) {
    if (!seen.has(k) && re.test(pill)) { seen.add(k); await page.screenshot({ path: `${out}/${k}.png` }); }
  }
  await sleep(120);
}
// the ··· sheet
await page.click(".more");
await sleep(500);
await page.screenshot({ path: `${out}/07-sheet.png` });
await page.click(".more");
await sleep(300);
await page.click(".ctl--end");
await page.waitForSelector(".result", { timeout: 90000 }).catch(() => {});
await sleep(2000);
await page.screenshot({ path: `${out}/08-result.png`, fullPage: true });
// settings
await page.click(".page__actions .btn--ghost").catch(() => {});
await sleep(600);
for (const b of await page.$$("button.btn--ghost")) { const t = await page.evaluate((e) => e.textContent, b); if (t?.includes("設定")) { await b.click(); break; } }
await sleep(700);
await page.screenshot({ path: `${out}/09-settings.png`, fullPage: true });
// 10 — mobile conversation
const m = await browser.newPage();
await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await m.evaluateOnNewDocument(() => localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true })));
await m.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await sleep(1200);
await m.screenshot({ path: `${out}/10a-mobile-home.png` });
const macts = await m.$$("button.act");
if (macts[2]) { await macts[2].click(); await m.waitForSelector(".pill", { timeout: 30000 }).catch(() => {}); await sleep(12000); await m.screenshot({ path: `${out}/10-mobile-session.png` }); await m.click(".ctl--end").catch(() => {}); }
await browser.close();
console.log("shots in", out, "errors:", JSON.stringify(errors));
