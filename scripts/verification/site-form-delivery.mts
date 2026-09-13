import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const web=createRequire(new URL('../../apps/web/package.json',import.meta.url));
const server=createRequire(new URL('../../services/token-broker/package.json',import.meta.url));
const {Firestore}=server('@google-cloud/firestore');
assert.ok(process.env.GOOGLE_CLOUD_PROJECT);
const db=new Firestore({projectId:process.env.GOOGLE_CLOUD_PROJECT,databaseId:'ai-meeting-zoom'});
const browser=await web('puppeteer-core').launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
let id:string|undefined;const result:Record<string,unknown>={};
try{
 const page=await browser.newPage();
 page.on('request',r=>{if(r.url().endsWith('/api/site/leads')&&r.method()==='POST'&&r.postData())id=JSON.parse(r.postData()).requestId;});
 await page.goto('http://127.0.0.1:5196/ja.html',{waitUntil:'networkidle2'});
 await page.type('[name=name]','Synthetic browser delivery check');
 await page.type('[name=email]',`browser-${randomUUID()}@example.invalid`);
 await page.select('[name=useCase]','training');
 await page.type('[name=message]','Synthetic browser delivery verification only. No real inquiry or email.');
 await page.click('[name=consent]');await page.click('#lead-form button');
 await page.waitForFunction(()=>document.querySelector('#lead-status').textContent.includes('受付番号'));
 assert.ok(id);const saved=await db.collection('ai_meeting_site_leads').doc(id).get();assert.ok(saved.exists);
 result.passed=true;result.receiptDisplayed=true;result.privateRecordVerified=true;
 result.formCleared=await page.$eval('[name=message]',e=>(e as HTMLInputElement).value==='');
}finally{
 await browser.close();if(id){await db.collection('ai_meeting_site_leads').doc(id).delete();result.syntheticRecordDeleted=true;}
 await mkdir('artifacts/site-intake',{recursive:true});await writeFile('artifacts/site-intake/browser-delivery.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}
