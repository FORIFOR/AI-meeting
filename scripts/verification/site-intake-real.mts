import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../../services/token-broker/package.json',import.meta.url));const {Firestore}=require('@google-cloud/firestore');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,base=process.env.SITE_BROKER_URL;assert.ok(projectId&&base);
const db=new Firestore({projectId,databaseId:'ai-meeting-zoom'}),id=randomUUID();
const payload={requestId:id,name:'Synthetic site verification',email:`verification-${id}@example.invalid`,organization:'Automated validation',useCase:'training',message:'Synthetic inquiry to verify durable private form delivery. No customer message.',consent:true,website:'',language:'ja'};
const report:Record<string,any>={input:'Synthetic business inquiry; no email sent'};
const post=(value:unknown,origin='https://ai-meeting.forifor.chatgpt.site')=>fetch(`${base}/api/site/leads`,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(value)});
try{
 const first=await post(payload);report.status=first.status;assert.equal(first.status,201);const receipt=(await first.json()as any).receipt;assert.ok(receipt);
 const saved=await db.collection('ai_meeting_site_leads').doc(id).get();assert.ok(saved.exists);assert.equal(saved.data().email,payload.email);report.durablySaved=true;report.retentionDays=Math.round((saved.data().expiresAt.toMillis()-saved.data().createdAt.toMillis())/86400000);assert.equal(report.retentionDays,90);
 const retry=await post(payload);assert.equal((await retry.json()as any).receipt,receipt);report.idempotentRetry=true;
 report.invalidStatus=(await post({...payload,consent:false})).status;assert.equal(report.invalidStatus,400);
 report.foreignOriginStatus=(await post(payload,'https://example.invalid')).status;assert.equal(report.foreignOriginStatus,403);
 report.publicReadStatus=(await fetch(`${base}/api/site/leads`,{headers:{origin:'https://ai-meeting.forifor.chatgpt.site'}})).status;assert.equal(report.publicReadStatus,405);
 const publicRead=await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/ai-meeting-zoom/documents/ai_meeting_site_leads/${id}`);report.unauthenticatedFirestoreStatus=publicRead.status;assert.equal(publicRead.status,403);
 report.passed=true;
}finally{await db.collection('ai_meeting_site_leads').doc(id).delete();report.syntheticRecordDeleted=true;await mkdir('artifacts/site-intake',{recursive:true});await writeFile('artifacts/site-intake/real-verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
