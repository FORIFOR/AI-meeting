/** Executed Hosted Meet test harness, 30-minute target, synthetic audio only.
 * MEETING_URL=https://meet.google.com/... node docs/reports/release/auto-go-20260909/hosted-meet.mjs
 * Requires gcloud access to the existing Hosted secret, say/Kyoko, ffmpeg and ffprobe.
 * OUT defaults to a private /tmp folder: sessions.json contains tokens and MUST NOT be committed.
 * HTTP 5xx status GETs retry twice; audio POSTs never retry implicitly. All created bots leave in finally.
 * A completed timer is not a functional PASS; inspect responses, silence and cleanup separately.
 */
import{fileURLToPath}from'node:url';import{resolve,dirname}from'node:path';
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{execFileSync}from'node:child_process';import{createRequire}from'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..'),WS=createRequire(root+'/services/token-broker/package.json')('ws');
const key=execFileSync('gcloud',['secrets','versions','access','latest','--secret=ai-meeting-broker-hosted-attendee-api-key','--project=gen-lang-client-0307428960'],{encoding:'utf8'}).trim();
const broker='https://ai-meeting-broker-pdygkns5gq-an.a.run.app',folder=process.env.OUT??('/tmp/rcai-hosted-meet-'+Date.now());mkdirSync(folder,{recursive:true,mode:0o700});
if(!process.env.MEETING_URL)throw Error('MEETING_URL is required');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const bots=[];let socket;
const report={startedAt:new Date().toISOString(),scope:'Real Hosted Meet, synthetic tester, 30-minute target; not human evaluation',rows:[],states:[],energy:[],cleanup:[]};
const save=()=>writeFileSync(folder+'/result.json',JSON.stringify(report,null,2),{mode:0o600});
const api=async(bot,path='',body)=>{for(let attempt=0;attempt<3;attempt++){
 const r=await fetch('https://app.attendee.dev/api/v1/bots/'+bot.botId+path,{method:body?'POST':'GET',headers:{Authorization:'Token '+key,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
 if(!r.ok){(report.apiErrors??=[]).push({at:Date.now(),path:path||'status',status:r.status,attempt});save();if(!body&&r.status>=500&&attempt<2){await sleep(1000*(attempt+1));continue;}throw Error('Attendee HTTP '+r.status);}
 const t=await r.text();return t?JSON.parse(t):{};
}};
const lines={greet:'ゆい、こんにちは。私の声が聞こえたら、聞こえます、と返してください。',numbers:'ゆい、明日の十五時から一時間の予定です。開始時刻と終了時刻を確認してください。',followup:'ゆい、その予定は何時に終わりますか。',long:'ゆい、英会話の練習方法を三つ、少し詳しく説明してください。',cut:'ちょっと待って。短い答えにしてください。',resume:'ゆい、もう一度会話を続けます。英語でおはようは何と言いますか。'};
for(const[id,text]of Object.entries(lines)){execFileSync('say',['-v','Kyoko','-o',folder+'/'+id+'.aiff',text]);execFileSync('ffmpeg',['-y','-loglevel','error','-i',folder+'/'+id+'.aiff',folder+'/'+id+'.mp3']);}
const clips=new Map();for(const id of ['greet','numbers','followup','long','cut','resume']){const file=folder+'/'+id+'.mp3';clips.set(id,{data:readFileSync(file).toString('base64'),seconds:Number(execFileSync('ffprobe',['-v','quiet','-show_entries','format=duration','-of','csv=p=0',file],{encoding:'utf8'}))});}
try{
 for(const role of ['character','listener']){
  const body={meetingUrl:process.env.MEETING_URL,botName:role==='character'?'Yui':'Tester',role,transcription:'closed_captions',recording:{format:'mp3'},automaticLeave:{maxUptimeSeconds:2400,silenceTimeoutSeconds:3600},botPageQuery:{character:'yui',persona:'meeting_colleague_ja',engine:'google',voice:'Aoede',proactivity:'addressed_only',language:'ja-JP',outbound:'page',vision:'off'}};
  const res=await fetch(broker+'/api/meeting/attendee/bots',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  if(!res.ok)throw Error('Bot creation HTTP '+res.status);
  const bot=await res.json();bots.push({...bot,role});writeFileSync(folder+'/sessions.json',JSON.stringify(bots),{mode:0o600});console.log('Created '+body.botName+' '+bot.botId);
 }
 report.botIds=bots.map(b=>({role:b.role,botId:b.botId}));save();
 const deadline=Date.now()+300000;let admitted=false,last='';
 while(Date.now()<deadline){const states=await Promise.all(bots.map(async b=>({role:b.role,state:(await api(b)).state})));const sig=JSON.stringify(states);if(sig!==last){last=sig;report.states.push({at:Date.now(),states});console.log(sig);save();}if(states.every(s=>['joined_recording','joined_not_recording'].includes(s.state))){admitted=true;break;}if(states.some(s=>['ended','fatal_error'].includes(s.state)))throw Error('Bot ended before admission');await sleep(5000);}
 if(!admitted)throw Error('Admission not completed within 5 minutes');
 const[yui,tester]=bots;report.admittedAt=new Date().toISOString();const started=Date.now();const until=started+1800000;
 const page=async()=>{const r=await fetch(broker+'/api/meeting/session/'+yui.sessionId,{headers:{Authorization:'Bearer '+yui.clientToken},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Session observation HTTP '+r.status);return r.json();};
 socket=new WS(tester.clientWsUrl);socket.on('error',()=>{report.relayError=true;});socket.on('message',raw=>{try{const outer=JSON.parse(String(raw)),m=outer.message??outer;if(m.trigger!=='realtime_audio.mixed'||!m.data?.chunk)return;const b=Buffer.from(m.data.chunk,'base64');let sum=0;for(let i=0;i+1<b.length;i+=2)sum+=(b.readInt16LE(i)/32768)**2;report.energy.push({at:Date.now(),rms:Math.sqrt(sum/Math.max(1,b.length/2))});}catch{}});
 const speak=async id=>{const c=clips.get(id);await api(tester,'/output_audio',{type:'audio/mp3',data:c.data});await sleep(c.seconds*1000+500);return Date.now();};
 await sleep(10000);let turn=0;
 while(Date.now()<until-40000){
  const id=['greet','numbers','followup','long','resume'][turn++%5],start=Date.now();let end=await speak(id),cutAt=null;
  if(id==='long'){const wait=Date.now()+15000;while(Date.now()<wait){const p=await page();if(p.pageEvents?.some(e=>e.type==='speaking'&&e.at>=start)){await sleep(1000);cutAt=Date.now();end=await speak('cut');break;}await sleep(500);}}
  await sleep(15000);const p=await page();const events=(p.pageEvents??[]).filter(e=>e.at>=start);const row={id,start,end,cutAt,events,heartbeat:p.pageHeartbeat?.data,audibleRoomChunksAfterCue:report.energy.filter(e=>e.at>end+500&&e.rms>.003).length};report.rows.push(row);console.log(JSON.stringify({turn,id,elapsedSeconds:Math.round((Date.now()-started)/1000),events:events.map(e=>e.type),audibleChunks:row.audibleRoomChunksAfterCue}));save();
  const states=await Promise.all(bots.map(b=>api(b)));if(states.some(b=>!['joined_recording','joined_not_recording'].includes(b.state)))throw Error('Bot left during test');
 }
 const silenceStart=Date.now();await sleep(Math.max(20000,until-Date.now()));const p=await page();report.silence={durationMs:Date.now()-silenceStart,newTurns:(p.pageEvents??[]).filter(e=>e.at>=silenceStart&&e.type==='turn').length};report.elapsedMs=Date.now()-started;report.execution='COMPLETE';
}catch(e){report.execution='FAIL';report.error=e.message;console.log('Test stopped: '+e.message);}
finally{
 socket?.close();for(const b of [...bots].reverse()){try{await api(b,'/leave',{});report.cleanup.push({botId:b.botId,leaveRequested:true});}catch(e){report.cleanup.push({botId:b.botId,leaveError:e.message});}}
 for(const b of bots){let state;for(let n=0;n<12;n++){try{state=(await api(b)).state;}catch{}if(['ended','fatal_error'].includes(state))break;await sleep(5000);}report.cleanup.find(x=>x.botId===b.botId).finalState=state;console.log('Final state '+b.botId+' '+state);}
 report.endedAt=new Date().toISOString();save();console.log('Finished; cleanup recorded.');process.exitCode=report.execution==='COMPLETE'?0:1;
}
