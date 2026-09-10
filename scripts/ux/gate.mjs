import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const limits={startupMs:[95,5000],responseMs:[95,1300],interruptionMs:[95,150],lipSyncOffsetMs:[95,80],speechDetectionMs:[95,100]};
export function assess(evidence){
 const rows=[];
 for(const [name,[percentile,limit]] of Object.entries(limits)){
  const raw=evidence?.samples?.[name];
  const valid=Array.isArray(raw)&&raw.length>=20&&raw.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=0);
  const sorted=valid?[...raw].sort((a,b)=>a-b):[];
  const value=valid?sorted[Math.ceil(sorted.length*percentile/100)-1]:null;
  rows.push({name:`${name}_p${percentile}`,value,limit,status:value===null?'MISSING':value<limit?'PASS':'FAIL'});
  if(name==='responseMs') {const median=valid?sorted[Math.ceil(sorted.length*.5)-1]:null;rows.push({name:'responseMs_p50',value:median,limit:700,status:median===null?'MISSING':median<700?'PASS':'FAIL'});}
 }
 const frames=evidence?.samples?.avatarFps;
 const fps=Array.isArray(frames)&&frames.length>=20&&frames.every(x=>Number.isFinite(x)&&x>=0)?[...frames].sort((a,b)=>a-b)[Math.ceil(frames.length*.05)-1]:null;
 rows.push({name:'avatarFps_p05',value:fps,limit:30,status:fps===null?'MISSING':fps>=30?'PASS':'FAIL'});
 for(const name of ['doubleSpeech','stuckSpeaking','stuckListening']) {const v=evidence?.incidents?.[name];rows.push({name,value:v??null,limit:0,status:typeof v!=='number'||!Number.isInteger(v)||v<0?'MISSING':v===0?'PASS':'FAIL'});}
 return {status:rows.every(r=>r.status==='PASS')?'PASS':'NOT_VERIFIED',rows};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const evidence=process.argv[2]?JSON.parse(readFileSync(process.argv[2],'utf8')):{};const result=assess(evidence);console.log(JSON.stringify(result,null,2));process.exitCode=result.status==='PASS'?0:1;}catch(e){console.error('UX evidence could not be read:',e.message);process.exitCode=1;}
}
