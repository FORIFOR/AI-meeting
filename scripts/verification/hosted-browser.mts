import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const serverRequire = createRequire(new URL('../../services/token-broker/package.json', import.meta.url));
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { initializeApp, applicationDefault } = serverRequire('firebase-admin/app');
const { getAuth } = serverRequire('firebase-admin/auth');
const puppeteer = webRequire('puppeteer-core');
const sdk = getAuth(initializeApp({ projectId: process.env.GOOGLE_CLOUD_PROJECT, credential: applicationDefault() }, 'browser-validation'));
const uid = `browser-validation-${randomBytes(10).toString('hex')}`, email = `${uid}@example.invalid`, password = randomBytes(30).toString('base64url');
const config = await (await fetch(process.env.FIREBASE_CONFIG_URL || 'https://ai-meeting.web.app/__/firebase/init.json')).text();
const inputWav = await readFile('artifacts/hosted-access/task.wav');
await mkdir('artifacts/hosted-browser', { recursive: true });
let browser: any, created = false;
const report: Record<string, any> = { input: 'Synthetic Kyoko voice through a WebAudio microphone MediaStream; no physical microphone', errors: [] };
try {
  await sdk.createUser({ uid, email, password, emailVerified: true }); created = true;
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(await (await fetch('/qa-input.wav')).arrayBuffer());
      const source = context.createBufferSource(); source.buffer = buffer;
      const destination = context.createMediaStreamDestination();
      source.connect(destination); source.start(); await context.resume();
      return destination.stream;
    };
  });
  const cdp = await page.createCDPSession(); await cdp.send('Network.enable');
  report.transcripts = []; report.toolCalls = [];
  cdp.on('Network.webSocketFrameReceived', event => {
    try { const m = JSON.parse(event.response.payloadData); for (const k of ['inputTranscription','outputTranscription']) if (m.serverContent?.[k]?.text) report.transcripts.push({ kind: k, text: m.serverContent[k].text }); if (m.toolCall) report.toolCalls.push(m.toolCall); } catch {}
  });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url().endsWith('/__/firebase/init.json')) return request.respond({ status: 200, contentType: 'application/json', body: config });
    if (request.url().endsWith('/qa-input.wav')) return request.respond({ status: 200, contentType: 'audio/wav', body: inputWav });
    return request.continue();
  });
  await page.goto('http://127.0.0.1:5180/#tasks', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.hosted-account button', { timeout: 20_000 });
  await page.click('.hosted-account button');
  await page.locator('.hosted-account input[type=email]').fill(email);
  await page.locator('.hosted-account input[type=password]').fill(password);
  await page.click('.hosted-account form .btn--primary');
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.tasks-summary button')?.disabled, { timeout: 20_000 });
  report.signedIn = true;
  await page.click('.tasks-summary button');
  await page.waitForFunction(() => Array.from(document.querySelectorAll('button')).some(b => b.textContent?.includes('はじめる') || b.textContent?.includes('始める')), { timeout: 15_000 });
  await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('はじめる') || b.textContent?.includes('始める')); b?.click(); });
  await page.waitForSelector('.session', { timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector('.stage__loading'), { timeout: 30_000 });
  report.sessionStarted = true;
  await page.evaluate(() => Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'ノート')?.click());
  await page.waitForSelector('.task-ledger li', { timeout: 45_000 });
  const proposal = await page.$('.task-review');
  if (proposal) {
    const text = await proposal.evaluate(e => e.textContent);
    assert.ok(text.includes('資料確認') && /9.?月.?15.?日/.test(text), 'proposal must match the authored fixture');
    await page.click('.task-review button'); report.proposalConfirmedAfterMatchingFixture = true;
  }
  const notes = await page.evaluate(() => { const b = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'ノート'); if (b) b.click(); return !!b; });
  report.notesOpened = notes;
  await page.waitForSelector('.task-ledger', { timeout: 20_000 });
  await page.screenshot({ path: 'artifacts/hosted-browser/session.png' });
  await page.click('.ctl--end');
  await page.waitForSelector('.result', { timeout: 30_000 });
  await page.click('.result a[href="#tasks"]');
  await page.waitForSelector('.task-card', { timeout: 20_000 });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.task-card', { timeout: 20_000 });
  report.restoredTasks = await page.$$eval('.task-card h2', es => es.map(e => e.textContent));
  assert.ok(report.restoredTasks.includes('資料確認'));
  report.passed = true;
} finally {
  if (browser) { const pages = await browser.pages(); const page = pages.at(-1); if (page) { report.lastScreen = (await page.evaluate(() => document.body.textContent)).replaceAll(email, '[synthetic-account]'); await page.screenshot({ path: 'artifacts/hosted-browser/latest-screen.png' }); } await browser.close(); }
  if (created) { await sdk.deleteUser(uid); report.syntheticAccountDeleted = true; }
  await writeFile('artifacts/hosted-browser/verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
