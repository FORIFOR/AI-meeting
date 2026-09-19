import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { ProjectWorkspace, projectContext, validateProject, type ProjectInput } from './projectWorkspace.js';
const input: ProjectInput = {title:'営業資料',goal:'金曜までに提案',decisions:['予算を先に確認'],openQuestions:['担当者は未定'],nextSteps:['予算確認']};
const fresh=()=>new ProjectWorkspace(`project-test-${crypto.randomUUID()}`);
describe('reviewed project continuity',()=>{
 it('restores a project on a new instance and the next day without character identity',async()=>{
  const name=`project-test-${crypto.randomUUID()}`,s=new ProjectWorkspace(name);const x=await s.save(input);
  const clock=vi.spyOn(Date,'now').mockReturnValue(x.updatedAt+86_400_000);
  try {expect(await new ProjectWorkspace(name).read(x.id)).toEqual(x);expect(projectContext(x)).toContain('未決事項を決定事項として扱わない');expect(projectContext(x)).not.toContain('characterId');}finally{clock.mockRestore();}
 });
 it('separates projects and protects stored values from mutation',async()=>{
  const s=fresh(),a=await s.save(input),b=await s.save({...input,title:'別案件'});a.decisions.push('not saved');
  expect((await s.read(a.id))?.decisions).toEqual(input.decisions);expect((await s.read(b.id))?.title).toBe('別案件');
 });
 it('rejects concurrent stale updates instead of overwriting a new decision',async()=>{
  const s=fresh(),x=await s.save(input);const r=await Promise.allSettled([s.save({...input,goal:'A'},x),s.save({...input,goal:'B'},x)]);
  expect(r.filter(x=>x.status==='fulfilled')).toHaveLength(1);expect(r.filter(x=>x.status==='rejected')).toHaveLength(1);expect((await s.read(x.id))?.revision).toBe(2);
 });
 it('cannot resurrect deleted memory via a stale editor',async()=>{const s=fresh(),x=await s.save(input);await s.remove(x);await expect(s.save(input,x)).rejects.toThrow();expect(await s.read(x.id)).toBeNull();});
 it('does not report success or erase the original when storage fails',async()=>{
  const s=fresh(),x=await s.save(input);const put=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw new DOMException('full','QuotaExceededError');});
  try{await expect(s.save({...input,goal:'lost'},x)).rejects.toThrow();}finally{put.mockRestore();}
  expect(await s.read(x.id)).toEqual(x);
 });
 it('bounds the total context and rejects malformed notes rather than silently trimming them',async()=>{
  const s=fresh(),x=await s.save({...input,decisions:Array(30).fill('a'.repeat(600)),openQuestions:Array(30).fill('b'.repeat(600)),nextSteps:Array(30).fill('c'.repeat(600))});
  expect(projectContext(x).length).toBeLessThan(6000);await expect(s.save({...input,title:'x'.repeat(161)},x)).rejects.toThrow();expect(()=>validateProject({...x,id:undefined})).toThrow();
 });
});
