import { it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createSiteIntake, portfolioOrigins, type SiteStore } from './site-intake.js';
const origin='https://reachmade.com';
const input={requestId:'ba0236d4-9f1b-41fb-bfbc-8c15f889af13',name:'QA',email:'qa@example.invalid',organization:'',useCase:'custom',message:'Synthetic test inquiry only.',consent:true,website:'',language:'ja'};
const memory=():SiteStore=>({lead:vi.fn(async()=>({receipt:'AM-1234ABCD'})),event:vi.fn(async()=>{})});
it('adds only the exact portfolio origin, not arbitrary subdomains',()=>{
 expect(portfolioOrigins).toContain(origin);
 expect(portfolioOrigins).not.toContain('https://reachmade.com.attacker.example');
 expect(portfolioOrigins).not.toContain('*');
});
it('accepts consented on-site inquiries through the existing storage contract',async()=>{
 const store=memory(),app=createSiteIntake({RCAI_MARKETING_ORIGIN:'https://original.example'},store);
 const r=await app.request('/leads',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
 expect(r.status).toBe(201);expect(await r.json()).toEqual({receipt:'AM-1234ABCD'});
 expect(store.lead).toHaveBeenCalledWith(input);
});
it('capability probes never read or write private inquiries or counters',async()=>{
 const store=memory(),app=new Hono();app.route('/api/site',createSiteIntake({RCAI_MARKETING_ORIGIN:'https://original.example'},store));
 const r=await app.request('/api/site/status',{headers:{Origin:origin}});
 expect(r.status).toBe(200);expect(await r.json()).toEqual({available:true});
 expect(r.headers.get('Cache-Control')).toBe('no-store');expect(store.lead).not.toHaveBeenCalled();expect(store.event).not.toHaveBeenCalled();
 for(const route of ['/api/site/leads','/api/site/events','/api/site/arbitrary/status'])expect((await app.request(route,{headers:{Origin:origin}})).status).toBe(405);
});
it('foreign origins cannot probe or submit',async()=>{
 const store=memory(),app=createSiteIntake({},store);
 for(const wrong of ['null','https://reachmade.com.attacker.example','https://evil.example']){
  expect((await app.request('/status',{headers:{Origin:wrong}})).status).toBe(403);
  expect((await app.request('/leads',{method:'POST',headers:{Origin:wrong,'Content-Type':'application/json'},body:JSON.stringify(input)})).status).toBe(403);
 }
 expect(store.lead).not.toHaveBeenCalled();
});
it('an unconfigured service never advertises available intake',async()=>{
 const app=createSiteIntake({});expect((await app.request('/status',{headers:{Origin:origin}})).status).toBe(503);
});
it('a configured service still rejects failed writes without a receipt',async()=>{
 const app=createSiteIntake({}, {lead:async()=>{throw Error('private database detail')},event:async()=>{}});
 const r=await app.request('/leads',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
 expect(r.status).toBe(503);expect(await r.json()).toEqual({error:'UNAVAILABLE'});
});
