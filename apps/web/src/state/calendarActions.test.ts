import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { CalendarActionStore, CalendarExecutor, validateCalendarPayload, type CalendarAdapter, type CalendarPayload } from './calendarActions.js';
const account={subject:'test-account',email:'example@example.com'};
const payload: CalendarPayload={title:'資料確認',start:'2026-09-21T10:00:00+09:00',end:'2026-09-21T10:30:00+09:00',timeZone:'Asia/Tokyo',projectId:'sales',taskId:'task-1'};
const store=()=>new CalendarActionStore(`calendar-test-${crypto.randomUUID()}`);
const adapter=():CalendarAdapter=>({account,insert:vi.fn(async()=>{}),matches:vi.fn(async()=> 'verified' as const)});
describe('approved durable calendar execution',()=>{
 it('only performs the external write after explicit approval and durable execution state, then reads it back',async()=>{
  const s=store(),a=adapter(),x=await s.draft(payload,account);expect(x.state).toBe('draft');expect(a.insert).not.toHaveBeenCalled();
  a.insert=vi.fn(async()=>{expect((await s.list())[0]?.state).toBe('executing');});
  const result=await new CalendarExecutor(s,()=>true).approve(x,a);expect(result.state).toBe('verified');expect(result.approvedAt).toBeTypeOf('number');expect(result.verifiedAt).toBeTypeOf('number');expect(a.insert).toHaveBeenCalledOnce();expect(a.matches).toHaveBeenCalledOnce();
 });
 it('keeps a lost-response result unknown across reload and reconciles by read only',async()=>{
  const name=`calendar-test-${crypto.randomUUID()}`,s=new CalendarActionStore(name),a=adapter(),x=await s.draft(payload,account);
  a.insert=vi.fn(async()=>{throw new Error('response lost after remote commit');});
  const unknown=await new CalendarExecutor(s,()=>true).approve(x,a);expect(unknown.state).toBe('unknown');
  const after=new CalendarActionStore(name),loaded=(await after.list())[0]!;expect(loaded.id).toBe(x.id);
  const verified=await new CalendarExecutor(after,()=>true).reconcile(loaded,a);expect(verified.state).toBe('verified');expect(a.insert).toHaveBeenCalledOnce();
  await expect(new CalendarExecutor(after,()=>true).approve(verified,a)).rejects.toThrow('再送しません');
 });
 it('serializes double clicks and tabs so only one insert occurs',async()=>{
  const s=store(),a=adapter(),x=await s.draft(payload,account),e=new CalendarExecutor(s,()=>true);
  const r=await Promise.allSettled([e.approve(x,a),e.approve(x,a)]);expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(a.insert).toHaveBeenCalledOnce();
 });
 it('refuses a second draft for a task with unresolved or completed execution',async()=>{const s=store();await s.draft(payload,account);await expect(s.draft(payload,account)).rejects.toThrow('既に');});
 it('blocks cloud access and wrong accounts without mutating a draft',async()=>{
  const s=store(),a=adapter(),x=await s.draft(payload,account);
  await expect(new CalendarExecutor(s,()=>false).approve(x,a)).rejects.toThrow('ローカル限定');
  await expect(new CalendarExecutor(s,()=>true).approve(x,{...a,account:{subject:'other',email:'other@example.com'}})).rejects.toThrow('異なります');
  expect((await s.list())[0]?.state).toBe('draft');expect(a.insert).not.toHaveBeenCalled();
 });
 it('does not send anything if the execution journal cannot commit',async()=>{
  const s=store(),a=adapter(),x=await s.draft(payload,account),put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new Error('disk full');});
  try{await expect(new CalendarExecutor(s,()=>true).approve(x,a)).rejects.toThrow();expect(a.insert).not.toHaveBeenCalled();}finally{put.mockRestore();}
  expect((await s.list())[0]?.state).toBe('draft');
 });
 for(const outcome of ['missing','mismatch'] as const)it(`does not claim success or reinsert after ${outcome} read-back`,async()=>{
  const s=store(),a=adapter();a.matches=vi.fn(async()=>outcome);const x=await s.draft(payload,account),e=new CalendarExecutor(s,()=>true);
  const result=await e.approve(x,a);expect(result.state).toBe('unknown');expect(result.verifiedAt).toBeUndefined();await e.reconcile(result,a);expect(a.insert).toHaveBeenCalledOnce();
 });
 it('reconciles a process terminated while executing without replaying the side effect',async()=>{
  const s=store(),a=adapter(),x=await s.draft(payload,account),executing=await s.change(x,{state:'executing',approvedAt:Date.now()});
  expect((await new CalendarExecutor(s,()=>true).reconcile(executing,a)).state).toBe('verified');expect(a.insert).not.toHaveBeenCalled();
 });
 it('validates precise times and time zones before drafting',()=>{
  expect(()=>validateCalendarPayload({...payload,start:'明日'})).toThrow();expect(()=>validateCalendarPayload({...payload,end:payload.start})).toThrow();expect(()=>validateCalendarPayload({...payload,timeZone:'bad/zone'})).toThrow();
 });
 it('stores no token even when an account object includes accidental extra properties',async()=>{
  const s=store();await s.draft(payload,{...account,token:'must-not-persist'} as any);expect(JSON.stringify(await s.list())).not.toContain('must-not-persist');
 });
});
