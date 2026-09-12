import { createRequire } from 'node:module';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const output = path.resolve('artifacts/task-workspace');
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 1000, deviceScaleFactor: 1 });
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: output });
  const url = process.env.APP_URL ?? 'http://127.0.0.1:5194/#tasks';
  await page.goto(url, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.task-add input:not([disabled])');
  await page.click('.workspace-nav button:first-child');
  await page.waitForSelector('.home');
  await page.evaluate(() => { location.hash = 'tasks'; });
  await page.waitForSelector('.task-add input:not([disabled])');
  for (const [title, due] of [['見積書を送る', '9月15日 15時'], ['商談メモを確認する', '明日'], ['次の打ち合わせを決める', '']]) {
    await page.locator('.task-add label:first-child input').fill(title);
    await page.locator('.task-add label:nth-child(2) input').fill(due);
    await page.click('.task-add button');
    await page.waitForFunction(value => Array.from(document.querySelectorAll('.task-card h2')).some(e => e.textContent === value), {}, title);
  }
  await page.click('button[aria-label="見積書を送るを完了にする"]');
  await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 2);
  await page.locator('.task-card:first-child .task-card__actions button:nth-child(2)').click();
  await page.waitForSelector('.task-card--deferred');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('.task-card--deferred');
  assert.equal(await page.$$eval('.task-card', es => es.length), 2);
  await page.click('.task-filter button:nth-child(3)');
  await page.waitForSelector('.task-card--done');
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'mobile horizontal overflow');
  await page.click('.tasks-backup summary');
  await page.click('.tasks-backup > button');
  let filename;
  for (let i = 0; i < 50 && !filename; i++) {
    filename = (await readdir(output)).find(f => f.startsWith('ai-meeting-tasks-') && f.endsWith('.json'));
    if (!filename) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(filename, 'backup download');
  await page.click('button[aria-label="見積書を送るを削除"]');
  await page.click('section[aria-label="削除の確認"] button');
  await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 2);
  const input = await page.$('input[type=file]');
  await input.uploadFile(path.join(output, filename));
  await page.waitForSelector('.tasks-backup .task-review');
  await page.click('.tasks-backup .task-review .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.task-card').length === 3);
  const other = await browser.newPage();
  await other.goto(url, { waitUntil: 'networkidle2' });
  await other.waitForSelector('.task-card');
  assert.equal(await other.$$eval('.task-card', es => es.length), 2);
  assert.equal(errors.length, 0, errors.join('\n'));
  const result = { passed: true, steps: ['navigate to tasks by hash', 'add three tasks', 'complete', 'defer', 'reload and restore', 'desktop/mobile layout', 'download backup', 'delete with confirmation', 'restore backup', 'second tab reads current tasks'], pageErrors: errors, horizontalOverflow: overflow };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
