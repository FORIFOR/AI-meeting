import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const viteRequire = createRequire(realpathSync(path.join(base, 'apps/web/node_modules/vite/package.json')));
const dir = await mkdtemp(path.join(tmpdir(), 'ai-meeting-timing-'));
const code = `
import { SpeakerOutput } from ${JSON.stringify(path.join(base, 'packages/audio-core/src/speaker.ts'))};
import { createFrame } from ${JSON.stringify(path.join(base, 'packages/audio-core/src/types.ts'))};
import { SessionObserver } from ${JSON.stringify(path.join(base, 'packages/observability/src/observer.ts'))};
export async function run() {
  const speaker = new SpeakerOutput();
  const observer = new SessionObserver({ sessionId: 'fixture-' + Date.now(), provider: 'fixture' });
  speaker.tap.subscribe(f => observer.notePlaybackFrame(f));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async predicate => { const deadline = performance.now() + 4000; while (!predicate()) { if (performance.now() > deadline) throw new Error('Timing observation missing: ' + JSON.stringify(observer.toReport().browserTiming)); await wait(10); } };
  try {
    await speaker.resume(); await speaker.whenReady();
    for (let i = 1; i <= 10; i++) {
      observer.handleEvent({ type: 'user_speech_started', at: performance.now() });
      observer.handleEvent({ type: 'user_speech_ended', at: performance.now() });
      await wait(100);
      observer.handleEvent({ type: 'assistant_transcript', text: 'synthetic fixture', final: true });
      observer.handleEvent({ type: 'assistant_speech_started', at: performance.now() });
      const pcm = Float32Array.from({ length: 24000 }, (_, j) => Math.sin(j * 2 * Math.PI * 440 / 24000) * .15);
      speaker.play(createFrame(pcm, 24000));
      await until(() => observer.toReport().browserTiming.playbackSignal.count === i);
      await wait(100);
      const at = performance.now(); speaker.interrupt();
      observer.handleEvent({ type: 'interrupted', at });
      observer.handleEvent({ type: 'user_speech_started', at });
      await until(() => observer.toReport().browserTiming.interruptionSilence.count === i);
      await wait(40);
    }
    observer.end();
    return observer.toReport().browserTiming;
  } finally { await speaker.close(); }
}`;
await viteRequire('esbuild').build({ stdin: { contents: code, resolveDir: base, loader: 'ts' }, outfile: path.join(dir, 'timing.mjs'), bundle: true, format: 'esm', platform: 'browser' });
const html = `<button id="go">Run</button><script type="module">import{run}from'/timing.mjs';document.querySelector('#go').onclick=()=>run().then(result=>window.result=result).catch(e=>window.failure=e.message);</script>`;
const server = createServer(async (req, res) => { res.setHeader('content-type', req.url === '/timing.mjs' ? 'application/javascript' : 'text/html'); res.end(req.url === '/timing.mjs' ? await readFile(path.join(dir, 'timing.mjs')) : html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await require('puppeteer-core').launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.click('#go');
  await page.waitForFunction(() => window.result || window.failure, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.failure), undefined);
  const timing = await page.evaluate(() => window.result);
  for (const metric of ['playbackSignal', 'subtitleArrival', 'interruptionSilence']) assert.equal(timing[metric].count, 10);
  const result = { measuredAt: new Date().toISOString(), scope: 'Ten deterministic tone playback/interruptions through real SpeakerOutput and its AudioWorklet tap. User speech/transcript events are simulated. No AI, microphone, human or physical-speaker timing claim.', browser: await browser.version(), passed: true, timing };
  await mkdir(path.join(base, 'artifacts/browser-timing'), { recursive: true });
  await writeFile(path.join(base, 'artifacts/browser-timing/verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser?.close(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); }
