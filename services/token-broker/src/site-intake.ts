import { createHash, randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { Hono } from 'hono';
import type { BrokerEnv } from './env.js';

export const SITE_EVENTS = ['demo_start','demo_complete','artifact_open','artifact_download','github_outbound','quickstart_open','vrm_preview_open','oss_preview_download','business_open'] as const;
const products = ['genie','launchloom','oathra','aisecure','agent-team'];
const scenarios = ['tasks','interview','english','walkthrough','ai-meeting',...products];
const uses = ['interview','training','language','tasks','custom',...products];
// Public marketing origins only. This route can create private inquiries and
// anonymous counters, never read them or grant access to the product APIs.
export const portfolioOrigins = ['https://astra-forifor.forifor.chatgpt.site','https://forifor.github.io','https://reachmade.com'];
export interface SiteEvent { event: typeof SITE_EVENTS[number]; scenario: string; language: 'ja'|'en' }
export interface SiteLead { requestId: string; name: string; email: string; organization: string; useCase: string; message: string; consent: true; website: ''; language: 'ja'|'en' }
export class IntakeError extends Error { constructor(readonly status: 400|409|429|503, readonly code: string) { super(code); } }
// `created` is false for an idempotent retry, so the owner is notified once per inquiry.
export interface SiteStore { lead(input: SiteLead): Promise<{receipt:string;created?:boolean}>; event(input: SiteEvent): Promise<void>; notice?(requestId: string, outcome: 'sent'|'failed'): Promise<void> }
export interface LeadNotice { receipt: string; useCase: string; language: 'ja'|'en' }
export type LeadNotifier = (notice: LeadNotice) => Promise<void>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const language = (v: unknown): v is 'ja'|'en' => v === 'ja' || v === 'en';
function object(value: unknown, keys: string[]): Record<string,any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k))) throw new IntakeError(400,'INVALID_INPUT');
  return value as Record<string,any>;
}
export function parseSiteEvent(value: unknown): SiteEvent {
  const v=object(value,['event','scenario','language']);
  if(!SITE_EVENTS.includes(v.event)||!scenarios.includes(v.scenario)||!language(v.language))throw new IntakeError(400,'INVALID_INPUT');
  return {event:v.event,scenario:v.scenario,language:v.language};
}
export function parseSiteLead(value: unknown): SiteLead {
  const v=object(value,['requestId','name','email','organization','useCase','message','consent','website','language']);
  const fields=[['name',1,80],['email',3,254],['organization',0,120],['message',10,2000]] as const;
  for(const [key,min,max]of fields){if(typeof v[key]!=='string'||v[key].trim().length<min||v[key].length>max)throw new IntakeError(400,'INVALID_INPUT');v[key]=v[key].trim();}
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)||!uses.includes(v.useCase)||v.consent!==true||v.website!==''||!language(v.language)||typeof v.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v.requestId))throw new IntakeError(400,'INVALID_INPUT');
  return v as SiteLead;
}
export class FirestoreSiteStore implements SiteStore {
  readonly db: Firestore;
  constructor(project: string,databaseId:string,private readonly now=Date.now){this.db=new Firestore({projectId:project,databaseId});}
  async lead(input:SiteLead){
    const day=new Date(this.now()).toISOString().slice(0,10),emailHash=hash(input.email.toLowerCase());
    const {requestId,website,...content}=input;
    const fingerprint=hash(JSON.stringify(content));
    return this.db.runTransaction(async tx=>{
      const ref=this.db.collection('ai_meeting_site_leads').doc(requestId);
      const usageRef=this.db.collection('ai_meeting_site_lead_usage').doc(day);
      const [existing,usage]=await Promise.all([tx.get(ref),tx.get(usageRef)]);
      if(existing.exists){if(existing.data()!.fingerprint!==fingerprint)throw new IntakeError(409,'REQUEST_CONFLICT');return {receipt:existing.data()!.receipt as string,created:false};}
      const data=usage.exists?usage.data()!:{total:0,emails:{}};
      if(!Number.isInteger(data.total)||data.total<0||!data.emails||typeof data.emails!=='object'||Object.values(data.emails).some(n=>!Number.isInteger(n)||Number(n)<0))throw new IntakeError(503,'UNAVAILABLE');
      if(data.total>=100||(data.emails[emailHash]??0)>=3)throw new IntakeError(429,'CAPACITY');
      const receipt=`AM-${randomUUID().slice(0,8).toUpperCase()}`;
      tx.create(ref,{...content,fingerprint,receipt,createdAt:Timestamp.fromMillis(this.now()),expiresAt:Timestamp.fromMillis(this.now()+90*86400000),status:'new'});
      tx.set(usageRef,{total:data.total+1,emails:{...data.emails,[emailHash]:(data.emails[emailHash]??0)+1},expiresAt:Timestamp.fromMillis(this.now()+90*86400000)});
      return {receipt,created:true};
    });
  }
  async notice(requestId:string,outcome:'sent'|'failed'){
    await this.db.collection('ai_meeting_site_leads').doc(requestId).update({notice:outcome});
  }
  async event(input:SiteEvent){
    const day=new Date(this.now()).toISOString().slice(0,10);
    const ref=this.db.collection('ai_meeting_site_events').doc(day);
    await this.db.runTransaction(async tx=>{
      const existing=await tx.get(ref),data=existing.exists?existing.data()!:{total:0,counts:{}};
      if(!Number.isInteger(data.total)||data.total<0||!data.counts||typeof data.counts!=='object')throw new IntakeError(503,'UNAVAILABLE');
      if(data.total>=20000)throw new IntakeError(429,'CAPACITY');
      const key=`${input.event}:${input.scenario}:${input.language}`;const previous=data.counts[key]??0;
      if(!Number.isInteger(previous)||previous<0)throw new IntakeError(503,'UNAVAILABLE');
      tx.set(ref,{total:data.total+1,counts:{...data.counts,[key]:previous+1},expiresAt:Timestamp.fromMillis(this.now()+90*86400000)});
    });
  }
}
// The privacy page names only Google Cloud as the inquiry destination, so the
// email carries no contact details or message. Read those with site-inbox --details.
export function resendNotifier(env:BrokerEnv,fetcher:typeof fetch=fetch):LeadNotifier|undefined{
  if(!env.RESEND_API_KEY||!env.RCAI_LEAD_NOTIFY_TO)return undefined;
  return async({receipt,useCase,language})=>{
    const response=await fetcher('https://api.resend.com/emails',{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),
      headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`site-lead-${receipt}`},
      body:JSON.stringify({from:env.RCAI_LEAD_NOTIFY_FROM||'Reachmade <onboarding@resend.dev>',to:[env.RCAI_LEAD_NOTIFY_TO],
        subject:`新しい問い合わせ ${receipt}`,
        text:`受付番号: ${receipt}\n相談の種類: ${useCase}\n言語: ${language}\n\n内容は site-inbox.mts --details で確認してください。`})});
    await response.body?.cancel();
    if(!response.ok)throw new Error(`Resend HTTP ${response.status}`);
  };
}
export function createSiteIntake(env:BrokerEnv,override?:SiteStore,notifier:LeadNotifier|undefined=resendNotifier(env)){
  const app=new Hono<{Variables:{siteBody:unknown}}>();
  app.onError((e,c)=>e instanceof IntakeError?c.json({error:e.code},e.status):c.json({error:'UNAVAILABLE'},503));
  const enabled=!!env.RCAI_MARKETING_ORIGIN&&!!env.GOOGLE_CLOUD_PROJECT&&!!env.RCAI_HOSTED_FIRESTORE_DATABASE;
  const store=override??(enabled?new FirestoreSiteStore(env.GOOGLE_CLOUD_PROJECT!,env.RCAI_HOSTED_FIRESTORE_DATABASE!):undefined);
  app.use('*',async(c,next)=>{
    c.header('Cache-Control','no-store');
    const origin=c.req.header('Origin');
    if(!origin||![env.RCAI_MARKETING_ORIGIN,'http://127.0.0.1:5196',...portfolioOrigins].includes(origin))return c.json({error:'ORIGIN'},403);
    if(!store)return c.json({error:'UNAVAILABLE'},503);
    // Read-only capability probe. Never lists records or inspects private data.
    // A successful probe is not a guarantee that the next database write succeeds.
    if(c.req.method==='GET' && ['/status','/api/site/status'].includes(c.req.path))return c.json({available:true});
    if(c.req.method!=='POST')return c.json({error:'METHOD'},405);
    if(!c.req.header('Content-Type')?.startsWith('application/json'))return c.json({error:'CONTENT_TYPE'},415);
    // Limit actual streamed bytes too; a forged Content-Length cannot bypass this bound.
    const reader=c.req.raw.body?.getReader();let length=0;const chunks:Uint8Array[]=[];
    if(!reader)return c.json({error:'INVALID_INPUT'},400);
    while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>8192){await reader.cancel();return c.json({error:'TOO_LARGE'},413);}chunks.push(part.value);}
    try{c.set('siteBody',JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{return c.json({error:'INVALID_INPUT'},400);}
    try{await next();}catch(e){if(e instanceof IntakeError)return c.json({error:e.code},e.status);return c.json({error:'UNAVAILABLE'},503);}
  });
  app.post('/leads',async c=>{
    const lead=parseSiteLead(c.get('siteBody'));
    const {receipt,created}=await store!.lead(lead);
    // The inquiry is already durable; a failed email must not turn it into an error.
    // The outcome is kept on the record so site-inbox can show unnotified inquiries.
    if(created&&notifier){
      const outcome=await notifier({receipt,useCase:lead.useCase,language:lead.language}).then(()=>'sent' as const,e=>{console.error('[site-intake] lead notice failed',receipt,e instanceof Error?e.message:'');return 'failed' as const;});
      await store!.notice?.(lead.requestId,outcome).catch(()=>{});
    }
    return c.json({receipt},201);
  });
  app.post('/events',async c=>{await store!.event(parseSiteEvent(c.get('siteBody')));return c.body(null,204);});
  return app;
}
