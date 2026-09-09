/** Real PCM input / real cloud sockets. Diagnostic only; not a human or browser acceptance test. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { GeminiLiveProvider } from '../../../../providers/gemini/src/geminiLiveProvider.js';
import { createFrame } from '../../../../packages/audio-core/src/types.js';
const WS = createRequire(new URL('../../../../services/token-broker/package.json', import.meta.url))('ws');
const raw = readFileSync('/tmp/latency-probe.pcm');
const pcm = Float32Array.from({length:raw.length/2}, (_, i) => raw.readInt16LE(i*2)/32768);
const sleep = (ms:number) => new Promise(r=>setTimeout(r,ms));
const rows:any[] = [];
// Balanced ABBA order limits systematic warm-up and time-of-run effects.
for (const affective of [true,false,false,true]) {
  const p = new GeminiLiveProvider({brokerUrl:'https://ai-meeting-broker-pdygkns5gq-an.a.run.app', enableAffectiveDialog:affective, wsFactory:u=>new WS(u)});
  let current:any;
  p.onEvent(e=>{
    if(!current) return;
    if(e.type==='metrics') current.metrics=e.turn;
    if(e.type==='user_transcript' && e.final) current.heard=e.text;
    if(e.type==='assistant_transcript' && e.final) current.reply=e.text;
    if(e.type==='error') current.error=String(e.error);
  });
  try {
    await p.connect({systemPrompt:'あなたは英会話練習の先生です。短い英語の質問を一つだけ返してください。',language:'ja-JP',mode:'free_talk',privacyMode:'default'});
    for(let turn=0;turn<3;turn++) {
      current={affective,turn};
      const push=async(d:Float32Array)=>{p.pushAudio(createFrame(d,16000,performance.now()));await sleep(20);};
      for(let i=0;i<60;i++) await push(new Float32Array(320));
      for(let i=0;i<pcm.length;i+=320) {const frame=new Float32Array(320);frame.set(pcm.subarray(i,i+320));await push(frame);}
      const end=Date.now()+15000;
      while(Date.now()<end && !current.metrics) await push(new Float32Array(320));
      rows.push(current);console.log(JSON.stringify(current));
      await sleep(3000);
    }
  } finally {await p.disconnect();}
}
writeFileSync(new URL('./results.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),kind:'synthetic-audio-provider-diagnostic',rows},null,2)+'\n');
