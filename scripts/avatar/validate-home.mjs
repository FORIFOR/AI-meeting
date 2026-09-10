import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
try {
 const page=await browser.newPage();
 await page.setRequestInterception(true);page.on('request',req=>req.url().startsWith('http://127.0.0.1:5185')||req.url().startsWith('data:')?req.continue():req.abort());
 await page.setViewport({width:1280,height:900});await page.goto('http://127.0.0.1:5185/');
 await page.waitForFunction(()=>document.body.textContent.includes('Yuiと話す'));
 await page.screenshot({path:'artifacts/avatar-validation/thinking-home.png',fullPage:true});
 await page.setViewport({width:390,height:844});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 await page.screenshot({path:'artifacts/avatar-validation/thinking-mobile.png',fullPage:true});
 if(overflow)throw new Error('Mobile overflow');
 console.log('Desktop and 390px home render; no horizontal overflow; external requests blocked');
}finally{await browser.close();}
