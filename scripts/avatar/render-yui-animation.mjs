// Run with the web Vite server on 5185. Produces GPU-independent frames of the real Live2D model.
import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless:true, args:['--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage(); await page.setViewport({width:640,height:360});
 await page.goto('http://127.0.0.1:5185/');
 const sheets=await page.evaluate(async(root)=>{
  const {Live2DAvatarProvider}=await import(`/@fs${root}/avatar-providers/live2d/src/live2dAvatar.ts`);
  const {loadCharacter,neutralParams}=await import(`/@fs${root}/packages/avatar-core/src/index.ts`);
  document.body.innerHTML='<div id="avatar" style="position:fixed;inset:0"></div>';
  const a=new Live2DAvatarProvider({container:document.querySelector('#avatar'),framing:'meeting',lipSyncEngine:'analyzer'});
  const character=await loadCharacter(`/@fs${root}/characters/yui`);
  await a.prepare(character);
  a.app.ticker.stop();
  const sheets=[];
  for(const mouth of [0,0.8]) {
   const sheet=document.createElement('canvas');sheet.width=5120;sheet.height=1440;const ctx=sheet.getContext('2d');
   ctx.fillStyle=character.view.background;ctx.fillRect(0,0,sheet.width,sheet.height);
   for(let i=0;i<32;i++) {
    const phase=i/32*Math.PI*2;
    a.applyParams({...neutralParams(),angleX:3*Math.sin(phase),angleZ:1.5*Math.sin(phase),breath:(1+Math.sin(phase))/2,eyeLOpen:i===22?0:i===21||i===23?0.5:1,eyeROpen:i===22?0:i===21||i===23?0.5:1,mouthOpenY:mouth});
    a.model.internalModel.update(125, i*125);a.app.renderer.render(a.app.stage);
    ctx.drawImage(a.app.view,(i%8)*640,Math.floor(i/8)*360,640,360);
   }
   sheets.push(sheet.toDataURL('image/webp',0.85));
  }
  await a.stop();return sheets;
 }, root);
 for(let i=0;i<sheets.length;i++) await writeFile(new URL(`../../apps/web/public/avatar-fallbacks/yui-${i?'speaking':'idle'}.webp`,import.meta.url),Buffer.from(sheets[i].split(',')[1],'base64'));
 console.log('Generated two 32-frame Yui animation sheets.');
} finally {await browser.close();}
