/** Real cloud synthesis with synthetic input. Objective PCM checks; no human listening score. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { GeminiLiveProvider } from '../../../../providers/gemini/src/geminiLiveProvider.js';
import { createFrame } from '../../../../packages/audio-core/src/types.js';
const WS=createRequire(new URL('../../../../services/token-broker/package.json',import.meta.url))('ws');
const folder='/tmp/auto-go-affective-samples';mkdirSync(folder,{recursive:true});
execFileSync('say',['-v','Kyoko','-o',folder+'/input.aiff','こんにちは。明日の午後三時から一時間、英会話を練習したいです。何時に終わるか、短く確認してください。']);
execFileSync('ffmpeg',['-y','-loglevel','error','-i',folder+'/input.aiff','-ar','16000','-ac','1','-f','s16le',folder+'/input.pcm']);
const input=readFileSync(folder+'/input.pcm');const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));const rows:any[]=[];
for(const voice of ['on-1','off-1','on-2','off-2','on-3','off-3','on-4','off-4','on-5','off-5']){
 const row:any={voice,startedAt:new Date().toISOString(),chunks:0,samples:0,nonFinite:0,clipped:0,peak:0,energy:0,heard:[],said:[],errors:[]};let firstAt=0,lastInputAt=0;const buffers:Buffer[]=[];
 const provider=new GeminiLiveProvider({brokerUrl:'https://ai-meeting-broker-pdygkns5gq-an.a.run.app',wsFactory:u=>new WS(u),googleSearch:false,enableAffectiveDialog:voice.startsWith('on')});
 provider.onEvent(e=>{
  if(e.type==='assistant_audio'){
   firstAt ||= Date.now();row.chunks++;row.sampleRate=e.frame.sampleRate;
   const b=Buffer.alloc(e.frame.data.length*2);
   for(let i=0;i<e.frame.data.length;i++){const v=e.frame.data[i];row.samples++;if(!Number.isFinite(v))row.nonFinite++;if(Math.abs(v)>=.999)row.clipped++;row.peak=Math.max(row.peak,Math.abs(v));row.energy+=v*v;b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,v))*32767),i*2);}buffers.push(b);
  }else if(e.type==='user_transcript' && e.final)row.heard.push(e.text);
  else if(e.type==='assistant_transcript' && e.final)row.said.push(e.text);
  else if(e.type==='error')row.errors.push('provider_error');
 });
 try{
  await provider.connect({voice:'Aoede',systemPrompt:'あなたはYuiです。質問に日本語で短く正確に答えてください。',language:'ja-JP',mode:'free_talk',privacyMode:'default'});
  const push=async(data:Float32Array)=>{provider.pushAudio(createFrame(data,16000,performance.now()));await sleep(20);};
  for(let i=0;i<35;i++)await push(new Float32Array(320));
  for(let o=0;o<input.length;o+=640){const d=new Float32Array(320);for(let i=0;i<320&&o+i*2+1<input.length;i++)d[i]=input.readInt16LE(o+i*2)/32768;await push(d);}lastInputAt=Date.now();
  for(let i=0;i<700;i++)await push(new Float32Array(320));
 }catch{row.errors.push('connection_or_audio_failure');}finally{await provider.disconnect();}
 row.firstAudioAfterInputMs=firstAt&&lastInputAt?firstAt-lastInputAt:null;row.rms=row.samples?Math.sqrt(row.energy/row.samples):null;delete row.energy;
 row.pcmChecksPassed=row.chunks>0&&row.nonFinite===0&&row.clipped===0&&row.errors.length===0;
 const pcm=Buffer.concat(buffers);writeFileSync(folder+'/'+voice+'.pcm',pcm);
 if(row.sampleRate)execFileSync('ffmpeg',['-y','-loglevel','error','-f','s16le','-ar',String(row.sampleRate),'-ac','1','-i',folder+'/'+voice+'.pcm',folder+'/'+voice+'.wav']);
 row.pcmSha256=createHash('sha256').update(pcm).digest('hex');row.audioFile=folder+'/'+voice+'.wav';rows.push(row);
 console.log(JSON.stringify(row));
 writeFileSync(new URL('./affective-comparison.json',import.meta.url),JSON.stringify({scope:'Paired diagnostic Aoede: affective dialog on/off, five trials each; same synthetic input; no production setting change',rows},null,2)+'\n');
}
