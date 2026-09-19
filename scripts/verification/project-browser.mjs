/** Real Chromium + IndexedDB UI smoke. No microphone, model API, Google login, or calendar writes. */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const require = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const base = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5180';
if (!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)) throw new Error('This smoke test creates synthetic data; use a local preview server only.');
const directory = path.resolve(process.env.E2E_OUTPUT ?? 'test-results/project-browser');
await mkdir(directory, {recursive:true});
const browser = await puppeteer.launch({executablePath:process.env.CHROME_BIN ?? '/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const errors = [];
try {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({width:1280,height:900});
  await page.emulateTimezone('Asia/Tokyo');
  page.on('pageerror',error=>errors.push(error.message));
  // No third-party requests. This test is local product UI, not a vendor integration test.
  await page.setRequestInterception(true);
  page.on('request',request=>{
    const url = request.url();
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) void request.continue();
    else void request.abort();
  });
  const click = async text => {
    await page.waitForFunction(t=>[...document.querySelectorAll('button')].some(b=>b.textContent===t&&!b.disabled),{},text);
    await page.evaluate(t=>[...document.querySelectorAll('button')].find(b=>b.textContent===t).click(),text);
  };
  const fill = async (selector,value) => { await page.waitForSelector(selector); await page.locator(selector).fill(value); };
  const text = async value => page.waitForFunction(t=>document.body.textContent.includes(t),{},value);
  await page.goto(`${base}/#projects`,{waitUntil:'networkidle0'});
  await click('新しい案件を作る');
  await fill('.project-form input','営業提案を仕上げる');
  await fill('.project-form label:nth-of-type(2) textarea','金曜日までに、お客様への提案をまとめる。');
  await fill('.project-form label:nth-of-type(3) textarea','まず予算を確認する\n資料の構成は3ページに絞る');
  await fill('.project-form label:nth-of-type(4) textarea','予算確認の担当者\n提出する時刻');
  await fill('.project-form label:nth-of-type(5) textarea','予算確認のメールを書く');
  await click('確認して案件に保存');
  await fill('input[placeholder="例：見積書を送る"]','お客様に予算を確認する');
  await fill('input[placeholder="例：9月15日 15時"]','9月21日 15時');
  await click('追加する');await text('タスクを保存しました。');
  await page.screenshot({path:path.join(directory,'project-desktop.png'),fullPage:true});
  const desktopOverflow = await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.project-grid button');await page.click('.project-grid button');
  await text('お客様に予算を確認する');await click('メモを確認・編集');
  await fill('.project-form label:nth-of-type(3) textarea','予算確認は自分が担当する\n資料の構成は3ページに絞る');
  await click('確認して案件に保存');await text('予算確認は自分が担当する');
  await page.setViewport({width:390,height:844});
  await page.screenshot({path:path.join(directory,'project-mobile.png'),fullPage:true});
  const mobileOverflow = await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  await click('案件メモを削除');await click('メモを削除する');
  await page.waitForFunction(()=>!document.querySelector('.project-notes')?.textContent.includes('予算確認は自分が担当する'));
  await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('.project-grid button');await page.click('.project-grid button');
  await text('お客様に予算を確認する');
  const cleared = await page.evaluate(()=>!document.querySelector('.project-notes')?.textContent.includes('予算確認は自分が担当する'));
  const result = {kind:'real-chromium-local-preview',physicalMicrophone:false,liveAI:false,liveGoogleCalendar:false,desktopWidth:1280,mobileWidth:390,desktopOverflow,mobileOverflow,errors,projectCreatedThroughUI:true,taskSurvivedReload:true,reviewedMemoEdited:true,deletedMemoAbsentAfterReload:cleared};
  await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));
  if(desktopOverflow||mobileOverflow||errors.length||!cleared)throw new Error(`Browser acceptance failed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
