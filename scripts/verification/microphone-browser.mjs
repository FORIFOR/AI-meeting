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
const esbuild = viteRequire('esbuild'), puppeteer = require('puppeteer-core');
const dir = await mkdtemp(path.join(tmpdir(), 'ai-meeting-mic-'));
await esbuild.build({ entryPoints: [path.join(base, 'packages/audio-core/src/mic.ts')], outfile: path.join(dir, 'mic.mjs'), bundle: true, format: 'esm', platform: 'browser' });
const html = `<button id="go">Start</button><script type="module">
import { MicCapture } from '/mic.mjs';
document.querySelector('#go').onclick = async () => {
  const inputContext = new AudioContext();
  const oscillator = inputContext.createOscillator();
  const destination = inputContext.createMediaStreamDestination();
  oscillator.connect(destination); oscillator.start(); await inputContext.resume();
  navigator.mediaDevices.getUserMedia = async () => destination.stream;
  const mic = new MicCapture({ echoCancellation: false, noiseSuppression: false });
  let frames = 0, peak = 0;
  mic.onFrame(frame => { frames++; for (const sample of frame.data) peak = Math.max(peak, Math.abs(sample)); });
  const stream = await mic.start();
  await new Promise(resolve => setTimeout(resolve, 1400));
  await mic.stop(); await inputContext.close();
  window.result = { input: 'Synthetic WebAudio oscillator; no physical microphone', frames, peak,
    tracksEnded: stream.getTracks().every(track => track.readyState === 'ended'), contextClosed: mic.context.state === 'closed' };
};
</script>`;
const server = createServer(async (req, res) => {
  if (req.url === '/mic.mjs') { res.setHeader('content-type', 'application/javascript'); res.end(await readFile(path.join(dir, 'mic.mjs'))); }
  else { res.setHeader('content-type', 'text/html'); res.end(html); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.click('#go'); await page.waitForFunction(() => window.result);
  const result = await page.evaluate(() => window.result);
  assert.ok(result.frames > 30); assert.ok(result.peak > .01);
  assert.ok(result.tracksEnded && result.contextClosed);
  await mkdir(path.join(base, 'artifacts/hosted-access'), { recursive: true });
  await writeFile(path.join(base, 'artifacts/hosted-access/microphone-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
