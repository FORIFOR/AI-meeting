import puppeteer from '../../apps/web/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js';
import {mkdirSync,writeFileSync} from 'node:fs';
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required']});
try {
 const page=await browser.newPage();
 await page.setRequestInterception(true);
 page.on('request',r=>/^(http:\/\/127\.0\.0\.1:5185|data:|blob:)/.test(r.url())?r.continue():r.abort());
 await page.goto('http://127.0.0.1:5185/');
 const result=await page.evaluate(async(root)=>{
  const {SpeakerOutput}=await import(`/@fs${root}/packages/audio-core/src/speaker.ts`);
  const {createFrame}=await import(`/@fs${root}/packages/audio-core/src/types.ts`);
  const sink=new SpeakerOutput();await sink.whenReady();await sink.resume();
  // Keep the graph alive after source removal so the tap can observe rendered silence.
  const silence=sink.context.createConstantSource();silence.offset.value=0;silence.connect(sink.gain);silence.start();
  const pcm=new Float32Array(24000);for(let i=0;i<pcm.length;i++)pcm[i]=.1*Math.sin(i*2*Math.PI*220/24000);
  const samples=[];
  try {for(let generation=1;generation<=20;generation++){
   await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{off();reject(new Error('No played PCM received'));},3000);
    let triggered=false,start=0;
    const off=sink.tap.subscribe(frame=>{
     const peak=frame.data.reduce((m,x)=>Math.max(m,Math.abs(x)),0);
     if(!triggered&&peak>.01){triggered=true;start=performance.now();sink.interrupt(generation+1);
      if(sink.queuedAudioMs!==0)reject(new Error('Audio queue survived cancel'));
      if(sink.play(createFrame(pcm,24000),{generationId:generation}))reject(new Error('Stale generation accepted'));
     }else if(triggered&&peak<.001){clearTimeout(timeout);off();samples.push(performance.now()-start);resolve();}
    });
    sink.play(createFrame(pcm,24000),{generationId:generation});
   });
  }}finally{silence.stop();silence.disconnect();await sink.close();}
  const sorted=[...samples].sort((a,b)=>a-b);
  return {scope:'local Chrome AudioWorklet rendered PCM stop; synthetic tone; no cloud/model/meeting',samplesMs:samples,p95Ms:sorted[18],maxMs:sorted[19],staleFramesDropped:sink.staleFramesDropped};
 },process.cwd());
 mkdirSync('artifacts/ux',{recursive:true});writeFileSync('artifacts/ux/local-playback.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 if(result.p95Ms>=150||result.staleFramesDropped!==20)throw new Error('Local playback cancellation gate failed');
}finally{await browser.close();}
