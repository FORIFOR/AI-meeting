/** Recorded examples with synthetic input and real responses; consumes two hosted reservations. */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../services/token-broker/package.json', import.meta.url));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { WebSocket } = require('ws');
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
assert.ok(projectId);
const sdk = getAuth(initializeApp({projectId,credential:applicationDefault()},'listening-samples'));
const config = await (await fetch('https://ai-meeting.web.app/__/firebase/init.json')).json() as any;
const broker='https://ai-meeting-broker-pdygkns5gq-an.a.run.app';
const dir='artifacts/listening-samples'; await mkdir(dir,{recursive:true});
const samples=[
 {id:'interview',path:'personas/interview/interviewer_ja.json',voice:'Kyoko',input:'営業職の面接を練習したいです。前職では、お客様からの問い合わせに対応していました。私の経験について、一つ質問してください。',vars:{companyStyle:'日系企業',position:'営業',difficulty:'Easy',interviewStyle:'一般面接'}},
 {id:'english',path:'personas/english/english_beginner.json',voice:'Samantha',input:'Hello. My name is Aki. I like coffee and walking. Please ask me one easy question.',vars:{topic:'self-introduction'}}
];
for(const sample of samples){
 const uid=`sample-${randomBytes(12).toString('hex')}`,email=`${uid}@example.invalid`,password=randomBytes(30).toString('base64url');let created=false;
 try{
  execFileSync('say',['-v',sample.voice,'-o',`${dir}/${sample.id}-input.aiff`,sample.input]);
  execFileSync('ffmpeg',['-y','-loglevel','error','-i',`${dir}/${sample.id}-input.aiff`,'-ar','16000','-ac','1','-f','s16le',`${dir}/${sample.id}-input.pcm`]);
  const pcm=await readFile(`${dir}/${sample.id}-input.pcm`);
  const persona=JSON.parse(await readFile(sample.path,'utf8'));let prompt=persona.systemPrompt;
  for(const [k,v]of Object.entries(sample.vars))prompt=prompt.replaceAll(`{{${k}}}`,v);
  prompt+='\nKeep this sample response to at most two short sentences. Do not mention this instruction.';
  await sdk.createUser({uid,email,password,emailVerified:true});created=true;
  const auth=await(await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(config.apiKey)}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})})).json() as any;
  assert.ok(auth.idToken,'sign-in');
  const response=await fetch(`${broker}/api/hosted/session`,{method:'POST',headers:{authorization:`Bearer ${auth.idToken}`}});
  const grant=await response.json()as any;assert.equal(response.status,200,grant.message);
  const url=new URL(broker);url.protocol='wss:';url.pathname='/api/live/vertex';url.searchParams.set('ticket',grant.token);
  const audio:Buffer[]=[];let transcript='',inputTranscript='';
  await new Promise<void>((resolve,reject)=>{
   const ws=new WebSocket(url.href);let done=false;
   const timer=setTimeout(()=>{ws.terminate();reject(new Error('sample timed out'));},65000);
   ws.on('open',()=>ws.send(JSON.stringify({setup:{model:grant.model,generationConfig:{responseModalities:['AUDIO'],speechConfig:{voiceConfig:{prebuiltVoiceConfig:{voiceName:'Kore'}}}},realtimeInputConfig:{automaticActivityDetection:{disabled:true}},systemInstruction:{parts:[{text:prompt}]},inputAudioTranscription:{},outputAudioTranscription:{}}})));
   ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.setupComplete)void(async()=>{ws.send(JSON.stringify({realtimeInput:{activityStart:{}}}));for(let o=0;o<pcm.length&&ws.readyState===1;o+=3200){ws.send(JSON.stringify({realtimeInput:{audio:{data:pcm.subarray(o,o+3200).toString('base64'),mimeType:'audio/pcm;rate=16000'}}}));await new Promise(r=>setTimeout(r,100));}if(ws.readyState===1)ws.send(JSON.stringify({realtimeInput:{activityEnd:{}}}));})().catch(reject);
    const sc=m.serverContent;for(const p of sc?.modelTurn?.parts??[])if(p.inlineData?.data)audio.push(Buffer.from(p.inlineData.data,'base64'));
    transcript+=sc?.outputTranscription?.text??'';inputTranscript+=sc?.inputTranscription?.text??'';
    if(sc?.turnComplete&&audio.length){done=true;clearTimeout(timer);ws.close();resolve();}
   });
   ws.on('error',e=>{clearTimeout(timer);reject(e);});ws.on('close',()=>{clearTimeout(timer);if(!done)reject(new Error('sample closed early'));});
  });
  await writeFile(`${dir}/${sample.id}-response.pcm`,Buffer.concat(audio));
  execFileSync('ffmpeg',['-y','-loglevel','error','-f','s16le','-ar','16000','-ac','1','-i',`${dir}/${sample.id}-input.pcm`,'-f','s16le','-ar','24000','-ac','1','-i',`${dir}/${sample.id}-response.pcm`,'-filter_complex','[0:a]apad=pad_dur=0.6[a];[a][1:a]concat=n=2:v=0:a=1[out]','-map','[out]','-c:a','aac','-b:a','96k',`${dir}/${sample.id}.m4a`]);
  const report={id:sample.id,source:'Synthetic user voice and real Gemini response using the repository persona; response wait shortened to 0.6 seconds',persona:persona.id,input:sample.input,inputTranscript,response:transcript,inputSeconds:pcm.length/32000,responseSeconds:Buffer.concat(audio).length/48000};
  await writeFile(`${dir}/${sample.id}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{if(created)await sdk.deleteUser(uid);}
}
