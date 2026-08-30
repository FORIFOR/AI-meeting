/**
 * LipSync A/B runner: drives demo/ab.html in real (headless) Chrome for every corpus sentence and
 * variant, computes per-sentence metrics and writes docs/reports/lipsync/<engine>-<timestamp>.{json,md}.
 * Usage: node demo/ab-run.mjs --engine analyzer|motionsync [--character yui] [--base http://localhost:5180] [--limit N]
 * Requires the demo server: `pnpm --filter @rcai/avatar-live2d demo`.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const engine = arg("engine", "analyzer");
const character = arg("character", engine === "motionsync" ? "kei" : "yui");
const base = arg("base", "http://localhost:5180");
const limit = Number(arg("limit", "0"));
const repo = resolve(process.cwd(), "../..");
const corpus = JSON.parse(readFileSync(resolve(repo, "tools/lipsync-corpus/corpus.json"), "utf8"));
const outDir = resolve(repo, "docs/reports/lipsync");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required", "--no-sandbox", "--window-size=1200,800"], defaultViewport: { width: 1200, height: 800 } });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
await page.goto(`${base}/ab.html?engine=${engine}&character=${character}`, { waitUntil: "networkidle0", timeout: 60000 });
await page.waitForFunction(() => window.__ab && (window.__ab.ready || window.__ab.error), { timeout: 60000 });
const status = await page.evaluate(() => ({ ready: window.__ab.ready, error: window.__ab.error, diag: window.__ab.diag }));
if (!status.ready) {
  const code = /BLOCKED_BY_[A-Z_]+/.exec(status.error ?? "")?.[0] ?? "ERROR";
  const out = { engine, character, status: code, error: status.error, diag: status.diag, at: stamp };
  writeFileSync(`${outDir}/${engine}-${stamp}.json`, JSON.stringify(out, null, 2));
  writeFileSync(`${outDir}/${engine}-${stamp}.md`, `# LipSync A/B — ${engine} (${character})\n\n**${code}**\n\n\`\`\`\n${status.error}\n\`\`\`\n`);
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  process.exit(code === "ERROR" ? 1 : 0);
}

const items = [];
for (const s of corpus.sentences) {
  items.push({ ...s, variant: "normal", url: `/tools/lipsync-corpus/wav/${s.id}.wav` });
  items.push({ ...s, variant: "fast", tag: "早口", url: `/tools/lipsync-corpus/wav/${s.id}__fast.wav` });
  items.push({ ...s, variant: "quiet", tag: "小声", url: `/tools/lipsync-corpus/wav/${s.id}__quiet.wav` });
}
const selected = limit > 0 ? items.slice(0, limit) : items;
const results = [];
const failures = [];
for (const item of selected) {
  let r = null;
  for (let attempt = 1; attempt <= 3 && !r; attempt++) {
    try { r = await page.evaluate((url) => window.__ab.run(url), encodeURI(item.url)); }
    catch (e) { if (attempt === 3) failures.push({ id: item.id, variant: item.variant, error: String(e).slice(0, 200) }); else await new Promise((res) => setTimeout(res, 500)); }
  }
  if (!r) continue;
  results.push({ ...item, metrics: metricsFor(r), samples: r.samples.length });
  process.stdout.write(`${item.id}/${item.variant} `);
}
// Interrupt check on one long sentence: mouth must hit 0 within the same tick.
const interrupt = await page.evaluate((url) => window.__ab.run(url, { interruptAtMs: 1200 }), encodeURI("/tools/lipsync-corpus/wav/長文_01.wav"));
const interruptMetrics = { openBefore: interrupt.interruptOpenBefore, openAfter: interrupt.interruptOpenAfter, ms: interrupt.interruptMs, maxOpenAfter: Math.max(0, ...interrupt.samples.filter((s) => s.t > interrupt.interruptAt + 5).map((s) => s.open)) };
await browser.close();

const byTag = {};
for (const r of results) (byTag[r.tag] ??= []).push(r.metrics);
const avg = (arr, k) => { const v = arr.map((m) => m[k]).filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const summary = Object.fromEntries(Object.entries(byTag).map(([tag, ms]) => [tag, { n: ms.length, coverage: avg(ms, "coverage"), spurious: avg(ms, "spurious"), openLatencyMs: avg(ms, "openLatencyMs"), closeLatencyMs: avg(ms, "closeLatencyMs"), stopLatencyMs: avg(ms, "stopLatencyMs"), meanForm: avg(ms, "meanForm"), maxOpen: avg(ms, "maxOpen") }]));
const vowel = {};
for (const r of results.filter((x) => x.vowelClass && x.variant === "normal")) (vowel[r.vowelClass] ??= []).push(r.metrics.meanForm);
const vowelSummary = Object.fromEntries(Object.entries(vowel).map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / v.length]));
const overall = { n: results.length, coverage: avg(results.map((r) => r.metrics), "coverage"), spurious: avg(results.map((r) => r.metrics), "spurious"), openLatencyMs: avg(results.map((r) => r.metrics), "openLatencyMs"), closeLatencyMs: avg(results.map((r) => r.metrics), "closeLatencyMs"), stopLatencyMs: avg(results.map((r) => r.metrics), "stopLatencyMs"), formDifferentiation: (vowelSummary.wide ?? NaN) - (vowelSummary.narrow ?? NaN) };
const out = { engine, character, status: "PASS", at: stamp, diag: status.diag, overall, vowelSummary, interrupt: interruptMetrics, byTag: summary, failures, sentences: results.map((r) => ({ id: r.id, variant: r.variant, tag: r.tag, text: r.text, ...r.metrics })), pageErrors };
writeFileSync(`${outDir}/${engine}-${stamp}.json`, JSON.stringify(out, null, 2));
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
let md = `# LipSync A/B — ${engine} (${character}) — ${stamp}\n\n${results.length} runs (${corpus.sentences.length} sentences × normal/fast/quiet). Engine diag: \`${JSON.stringify(status.diag)}\`\n\n`;
md += `| overall | coverage % | spurious % | open ms | close ms | stop ms | form wide−narrow |\n|---|---|---|---|---|---|---|\n| all | ${f(overall.coverage * 100)} | ${f(overall.spurious * 100)} | ${f(overall.openLatencyMs, 0)} | ${f(overall.closeLatencyMs, 0)} | ${f(overall.stopLatencyMs, 0)} | ${f(overall.formDifferentiation, 2)} |\n\n`;
md += `Vowel-class mean mouthForm (normal takes): wide(i/e)=${f(vowelSummary.wide, 2)} open(a)=${f(vowelSummary.open, 2)} narrow(u/o)=${f(vowelSummary.narrow, 2)}\n\nInterrupt: mouth ${f(interruptMetrics.openBefore, 2)} → ${f(interruptMetrics.openAfter, 2)} in ${f(interruptMetrics.ms, 2)} ms; max open in the following 600 ms = ${f(interruptMetrics.maxOpenAfter, 3)}\n\n`;
md += `| tag | n | coverage % | spurious % | open ms | close ms | stop ms | mean form | max open |\n|---|---|---|---|---|---|---|---|---|\n`;
for (const [tag, m] of Object.entries(summary)) md += `| ${tag} | ${m.n} | ${f(m.coverage * 100)} | ${f(m.spurious * 100)} | ${f(m.openLatencyMs, 0)} | ${f(m.closeLatencyMs, 0)} | ${f(m.stopLatencyMs, 0)} | ${f(m.meanForm, 2)} | ${f(m.maxOpen, 2)} |\n`;
if (pageErrors.length) md += `\nPage errors: ${pageErrors.slice(0, 5).join("; ")}\n`;
if (failures.length) md += `\nFailed runs (${failures.length}): ${failures.map((f) => `${f.id}/${f.variant}`).join(", ")}\n`;
writeFileSync(`${outDir}/${engine}-${stamp}.md`, md);
console.log(`\n${md}`);

/** Metrics from mouth samples aligned with the played-audio envelope (both on performance.now()). */
function metricsFor(r) {
  const VOICED_DB = -42, SILENT_DB = -58;
  const env = r.envelope.map((e) => ({ t: e.t, db: e.rms <= 1e-9 ? -180 : 20 * Math.log10(e.rms) }));
  const openAt = (t) => { let best = null; for (const s of r.samples) { if (s.t <= t + 8) best = s; else break; } return best; };
  let voiced = 0, covered = 0, silent = 0, spurious = 0;
  let firstVoiced = null, lastVoiced = null;
  const forms = [];
  let quietRun = 0;
  for (const e of env) {
    const s = openAt(e.t);
    if (!s) continue;
    if (e.db > VOICED_DB) {
      voiced++; if (s.open > 0.15) covered++;
      if (firstVoiced === null) firstVoiced = e.t;
      lastVoiced = e.t;
      forms.push(s.form);
      quietRun = 0;
    } else if (e.db < SILENT_DB) {
      quietRun += 10;
      if (quietRun > 120) { silent++; if (s.open > 0.1) spurious++; }
    }
  }
  const firstOpen = r.samples.find((s) => s.open > 0.15)?.t ?? null;
  const closeAfter = lastVoiced === null ? null : r.samples.find((s) => s.t > lastVoiced && s.open < 0.05)?.t ?? null;
  const maxOpen = Math.max(0, ...r.samples.map((s) => s.open));
  const lastEnvT = env.length ? env[env.length - 1].t : r.endedAt;
  const stopT = r.samples.filter((s) => s.t > lastEnvT).find((s) => s.open < 0.02)?.t ?? null;
  return {
    coverage: voiced ? covered / voiced : NaN,
    spurious: silent ? spurious / silent : 0,
    openLatencyMs: firstVoiced !== null && firstOpen !== null ? firstOpen - firstVoiced : NaN,
    closeLatencyMs: lastVoiced !== null && closeAfter !== null ? closeAfter - lastVoiced : NaN,
    stopLatencyMs: stopT !== null ? stopT - lastEnvT : NaN,
    meanForm: forms.length ? forms.reduce((a, b) => a + b, 0) / forms.length : NaN,
    maxOpen,
    voicedFrames: voiced,
    silentFrames: silent,
  };
}
