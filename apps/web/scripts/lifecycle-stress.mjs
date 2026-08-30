/**
 * Round 3 Gate 2 evidence: 100× session mount/unmount + route transitions in real headless Chrome.
 * PASS = uncaught exceptions 0, console errors 0, leaked AudioContexts 0, leaked MediaStreamTracks 0.
 * Usage: node apps/web/scripts/lifecycle-stress.mjs [iterations=100] [base=http://localhost:5177] [agentWs=ws://localhost:8793]
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const iterations = Number(process.argv[2] ?? 100);
const base = process.argv[3] ?? "http://localhost:5177";
const agentUrl = process.argv[4] ?? "ws://localhost:8793";
const outDir = resolve(process.cwd(), "docs/reports/img");
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--window-size=1280,860"],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const log = { chrome: await browser.version(), iterations, pageErrors: [], consoleErrors: [], leaks: [], heap: [], perIteration: [], startedAt: new Date().toISOString() };
page.on("pageerror", (e) => log.pageErrors.push(String(e).slice(0, 300)));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const t = m.text();
  if (/favicon/.test(t)) return;
  log.consoleErrors.push(t.slice(0, 300));
});
const cdp = await page.createCDPSession();
await cdp.send("Performance.enable");
const heap = async () => {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Math.round((metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1024 / 1024);
};
await page.evaluateOnNewDocument((agentUrl) => {
  localStorage.setItem("rcai.settings.v1", JSON.stringify({ brokerUrl: "http://localhost:8787", agentUrl, engine: "local", autoPolicy: "offline", advanced: {}, privacyMode: "strict_local", showHud: false, characterId: "yui", cameraOn: false, captionsOn: true }));
}, agentUrl);
const url = `${base}/?debug=1`;
await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => [...document.querySelectorAll("button.product")].some((b) => !b.disabled), { timeout: 30000 });

const live = () => page.evaluate(() => window.__rcaiAudio?.live() ?? null);
for (let i = 1; i <= iterations; i++) {
  const t0 = Date.now();
  if (i % 10 === 0) {
    await page.goto(`${url}&it=${i}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("button.product")].some((b) => !b.disabled), { timeout: 30000 });
  }
  await page.waitForFunction(() => [...document.querySelectorAll("button.product")].some((b) => !b.disabled), { timeout: 30000 });
  const products = await page.$$("button.product");
  if (!products[0]) {
    await page.screenshot({ path: `${outDir}/r3-lifecycle-fail-${i}.png` });
    log.pageErrors.push(`iteration ${i}: no product buttons: ${(await page.evaluate(() => document.body.innerText.slice(0, 300))).replace(/\n/g, " ")}`);
    break;
  }
  await products[0].click(); // Free Talk → session
  await page.waitForSelector(".pill", { timeout: 20000 });
  await sleep(1500);
  const pill = await page.evaluate(() => document.querySelector(".pill")?.textContent?.trim());
  const liveDuring = await live();
  // Alternate: End (→ Result) and abrupt route change (topbar/home via history) to exercise both paths.
  if (i % 3 === 0) {
    // abrupt: navigate to the same URL (full unload → pagehide → dispose)
    await page.goto(`${url}&r=${i}`, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForFunction(() => [...document.querySelectorAll("button.product")].some((b) => !b.disabled), { timeout: 30000 });
  } else {
    if (!(await page.$(".btn--danger"))) {
      const diag = await page.evaluate(() => ({ text: document.body.innerText.slice(0, 500), toasts: [...document.querySelectorAll(".toast")].map((t) => t.textContent) }));
      await page.screenshot({ path: `${outDir}/r3-lifecycle-fail-${i}.png` });
      log.pageErrors.push(`iteration ${i}: End button missing: ${JSON.stringify(diag)}`);
      break;
    }
    await page.click(".btn--danger");
    await page.waitForSelector(".result", { timeout: 60000 });
    await sleep(200);
    const home = await page.$$("xpath/.//div[contains(@class,'result')]//button[contains(., 'ホームへ')]");
    if (home[0]) await home[0].click();
    await page.waitForFunction(() => !!document.querySelector("button.product"), { timeout: 20000 });
  }
  await sleep(300);
  const after = await live();
  const h = await heap();
  const leak = !after || after.contexts !== 0 || after.tracks !== 0;
  if (leak) log.leaks.push({ i, after });
  log.heap.push(h);
  log.perIteration.push({ i, ms: Date.now() - t0, pill, during: liveDuring, after, heapMB: h });
  if (i % 10 === 0) console.log(`it ${i}: pill=${pill} during=${JSON.stringify(liveDuring)} after=${JSON.stringify(after)} heap=${h}MB errors=${log.pageErrors.length}/${log.consoleErrors.length}`);
}
await browser.close();
const summary = {
  iterations,
  uncaught: log.pageErrors.length,
  consoleErrors: log.consoleErrors.length,
  leakedContextsIterations: log.leaks.length,
  heapFirstMB: log.heap[0],
  heapLastMB: log.heap.at(-1),
  heapMaxMB: Math.max(...log.heap),
  pass: log.pageErrors.length === 0 && log.consoleErrors.length === 0 && log.leaks.length === 0,
};
writeFileSync(`${outDir}/r3-lifecycle.json`, JSON.stringify({ summary, ...log }, null, 2));
console.log(JSON.stringify({ summary, pageErrors: log.pageErrors.slice(0, 5), consoleErrors: log.consoleErrors.slice(0, 5), leaks: log.leaks.slice(0, 5) }, null, 2));
process.exit(summary.pass ? 0 : 1);
