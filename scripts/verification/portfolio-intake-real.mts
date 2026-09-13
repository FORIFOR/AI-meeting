import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../../services/token-broker/package.json',import.meta.url));
const {Firestore}=require('@google-cloud/firestore');
const db=new Firestore({projectId:'gen-lang-client-0307428960',databaseId:'ai-meeting-zoom'});
const base='https://ai-meeting-broker-pdygkns5gq-an.a.run.app/api/site/';
const results=[];
for(const product of ['genie','launchloom','oathra','aisecure','agent-team']){
 const id=randomUUID(),origin=product==='genie'?'https://astra-forifor.forifor.chatgpt.site':'https://forifor.github.io';
 const payload={requestId:id,name:'Synthetic portfolio validation',email:`qa-${id}@example.invalid`,organization:'Automated validation',useCase:product,message:'Synthetic private form delivery verification. No customer inquiry or email.',consent:true,website:'',language:'ja'};
 const post=()=>fetch(base+'leads',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(payload)});
 try{
  const preflight=await fetch(base+'leads',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}});
  assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  const first=await post();assert.equal(first.status,201);const response=await first.json() as any;
  const saved=await db.collection('ai_meeting_site_leads').doc(id).get();assert.equal(saved.data()?.useCase,product);
  assert.equal((await (await post()).json() as any).receipt,response.receipt);
  assert.equal((await fetch(base+'leads',{headers:{origin}})).status,405);
  results.push({product,cors:true,durableReceipt:true,idempotent:true,publicReadBlocked:true});
 }finally{await db.collection('ai_meeting_site_leads').doc(id).delete();}
}
await mkdir('artifacts/portfolio',{recursive:true});await writeFile('artifacts/portfolio/intake.json',JSON.stringify({results,syntheticRecordsDeleted:true,noEmailSent:true},null,2));
console.log(JSON.stringify({results,syntheticRecordsDeleted:true,noEmailSent:true}));
