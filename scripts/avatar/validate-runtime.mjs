// Local-only validation: no AI or meeting provider is contacted.
import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
try {
 const page = await browser.newPage(); await page.setViewport({width:1280,height:720});
 await page.goto('http://127.0.0.1:5185/');
 const result = await page.evaluate(async root => {
  const { Live2DAvatarProvider } = await import(`/@fs${root}/avatar-providers/live2d/src/live2dAvatar.ts`);
  const { loadCharacter, AvatarRuntime } = await import(`/@fs${root}/packages/avatar-core/src/index.ts`);
  document.body.innerHTML = '<div id="avatar" style="position:fixed;inset:0"></div>';
  const avatar = new Live2DAvatarProvider({container:document.querySelector('#avatar'),framing:'meeting',lipSyncEngine:'analyzer'});
  await avatar.prepare(await loadCharacter(`/@fs${root}/characters/yui`));
  const runtime = new AvatarRuntime(avatar);
  await avatar.start();
  avatar.setState('SPEAKING');
  let frames = 0; avatar.app.ticker.add(() => frames++);
  const started = performance.now();
  for(let i=0;i<60;i++) {
   const data = new Float32Array(960);
   for(let j=0;j<data.length;j++) data[j]=0.2*Math.sin(2*Math.PI*220*j/48000);
   runtime.pushAudio({data,sampleRate:48000,timestamp:performance.now(),channels:1});
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  const mouth = avatar.getParams().mouthOpenY;
  const elapsed=performance.now()-started;
  const measuredFps=frames/(elapsed/1000);
  avatar.interrupt();
  await new Promise(resolve=>setTimeout(resolve,100));
  const closed = avatar.getParams().mouthOpenY;
  const result={renderer:avatar.id,configuredFps:avatar.app.ticker.maxFPS,measuredFps,mouthWhileSpeaking:mouth,mouthAfterInterrupt:closed,canvasWidth:avatar.app.view.width,canvasHeight:avatar.app.view.height};
  window.validationAvatar=avatar;
  return result;
 },root);
 await page.screenshot({path:`${root}/artifacts/avatar-validation/live2d.png`});
 await writeFile(`${root}/artifacts/avatar-validation/result.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 if(result.renderer!=='live2d'||result.configuredFps!==30||result.mouthWhileSpeaking<=0.05||result.mouthAfterInterrupt>0.05) throw new Error('Avatar runtime validation failed');
} finally {await browser.close();}
