// Offline 30 fps fallback, rendered from the same model. Requires Vite :5185 and ffmpeg.
import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
const scratch=await mkdtemp(`${tmpdir()}/avatar-video-`);
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();await page.setViewport({width:640,height:360});await page.goto('http://127.0.0.1:5185/');
 await page.evaluate(async root=>{
  const {Live2DAvatarProvider}=await import(`/@fs${root}/avatar-providers/live2d/src/live2dAvatar.ts`);
  const {loadCharacter,neutralParams}=await import(`/@fs${root}/packages/avatar-core/src/index.ts`);
  document.body.innerHTML='<div id="avatar" style="position:fixed;inset:0"></div>';
  window.avatar=new Live2DAvatarProvider({container:document.querySelector('#avatar'),framing:'meeting',lipSyncEngine:'analyzer'});
  await window.avatar.prepare(await loadCharacter(`/@fs${root}/characters/yui`));window.avatar.app.ticker.stop();window.neutral=neutralParams;
 },root);
 for(const pose of ['idle','speaking']) {
  for(let i=0;i<120;i++) {
   const data=await page.evaluate(({i,pose})=>{
    const a=window.avatar,phase=i/120*Math.PI*2;
    const eye=1-Math.max(0,1-Math.abs(i-83)/4);
    a.applyParams({...window.neutral(),angleX:3*Math.sin(phase),angleZ:1.5*Math.sin(phase),breath:(1+Math.sin(phase))/2,eyeLOpen:eye,eyeROpen:eye,mouthOpenY:pose==='speaking'?0.8:0});
    a.model.internalModel.update(1000/30,i*1000/30);a.app.renderer.render(a.app.stage);
    const out=document.createElement('canvas');out.width=640;out.height=360;const ctx=out.getContext('2d');ctx.fillStyle='#f6f1ea';ctx.fillRect(0,0,640,360);ctx.drawImage(a.app.view,0,0,640,360);return out.toDataURL('image/png').split(',')[1];
   },{i,pose});
   await writeFile(`${scratch}/${String(i).padStart(3,'0')}.png`,Buffer.from(data,'base64'));
  }
  execFileSync('ffmpeg',['-y','-loglevel','error','-framerate','30','-i',`${scratch}/%03d.png`,'-c:v','libvpx-vp9','-crf','28','-b:v','0','-pix_fmt','yuv420p','-an',`${root}/apps/web/public/avatar-fallbacks/yui-${pose}.webm`]);
 }
 console.log('Created two 120-frame 30fps silent WebM fallback loops');
} finally {await browser.close();await rm(scratch,{recursive:true,force:true});}
