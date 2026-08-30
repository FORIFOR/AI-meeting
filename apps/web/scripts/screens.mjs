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
await page.evaluateOnNewDocument(() => localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl: "ws://localhost:8788", engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: true, characterId: "yui", cameraOn: false, captionsOn: true })));
await page.goto(base, { waitUntil: "networkidle0", timeout: 60000 });
await sleep(1600);
await page.screenshot({ path: `${out}/01-home.png` });
const products = await page.$$("button.product");
await products[1].hover(); await sleep(500);
await page.screenshot({ path: `${out}/02-home-hover.png` });
await products[1].click();
await page.waitForSelector(".btn--primary.btn--lg, .pill", { timeout: 20000 });
await sleep(900);
await page.screenshot({ path: `${out}/03-setup.png` });
if (await page.$(".btn--primary.btn--lg")) await page.click(".btn--primary.btn--lg");
await page.waitForSelector(".pill", { timeout: 30000 });
await sleep(14000);
await page.screenshot({ path: `${out}/04-session.png` });
await sleep(14000);
await page.screenshot({ path: `${out}/05-session-late.png` });
await page.click(".btn--danger");
await page.waitForSelector(".result", { timeout: 90000 }).catch(() => {});
await sleep(2000);
await page.screenshot({ path: `${out}/06-result.png`, fullPage: true });
await browser.close();
console.log("shots in", out, "errors:", JSON.stringify(errors));
