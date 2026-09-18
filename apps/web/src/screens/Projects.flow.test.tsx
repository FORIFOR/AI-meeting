// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach, expect,it,vi} from 'vitest';
import {ProjectWorkspace, projectContext, type ProjectNote} from '../state/projectWorkspace.js';
import {TaskWorkspace} from '../state/taskWorkspace.js';
import {Projects} from './Projects.js';
import {ProjectResult} from './ProjectResult.js';
import type {SessionOutcome} from '../session/SessionController.js';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const db = new ProjectWorkspace();
beforeEach(async()=>{for(const p of await db.list()) await db.remove(p);});
async function settle(check:()=>void) { await vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,5));});check();}); }
async function fill(node: HTMLInputElement|HTMLTextAreaElement,value:string) {
 await act(async()=>{Object.getOwnPropertyDescriptor(node.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});
}
it('creates a project, saves reviewed decisions, reloads and resumes the same task workspace',async()=>{
 const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
 const start=vi.fn(async (_p:ProjectNote)=>{});
 const button=(label:string)=>[...host.querySelectorAll('button')].find(x=>x.textContent===label)!;
 try {
  await act(async()=>root.render(<Projects onBack={()=>{}} onStart={start} privacyMode="strict_local"/>));
  await act(async()=>button('新しい案件を作る').click());
  await fill(host.querySelector('input')!,'営業提案');
  const fields=host.querySelectorAll('textarea');await fill(fields[0]!,'金曜までに提案');await fill(fields[1]!,'予算を先に確認');await fill(fields[2]!,'確認の担当者');
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await settle(()=>expect(host.querySelector('[aria-label="保存済みの案件メモ"]')?.textContent).toContain('予算を先に確認'));
  const project=(await db.list())[0]!;
  const input=host.querySelector('input[placeholder="例：見積書を送る"]')! as HTMLInputElement;
  await fill(input,'予算を確認する');
  await act(async()=>host.querySelector('form.task-add')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await settle(()=>expect(host.textContent).toContain('タスクを保存しました'));
  const tasks=await new TaskWorkspace(`ai-meeting-project-tasks-${project.id}`).read();expect(tasks).toHaveLength(1);
  await act(async()=>button('この案件の続きから話す').click());await settle(()=>expect(start).toHaveBeenCalledOnce());
  expect(projectContext(start.mock.calls[0]![0])).toContain('確認の担当者');
  const outcome={record:{turns:[{role:'user',text:'担当は私。予算確認は完了しました。'}]},tasks,unconfirmedTaskChanges:1} as SessionOutcome;
  const done=vi.fn();await act(async()=>root.render(<ProjectResult project={project} outcome={outcome} onDone={done}/>));
  expect(host.textContent).toContain('これらは保存していません');
  const resultFields=host.querySelectorAll('textarea');await fill(resultFields[1]!,'予算確認の担当は私');await fill(resultFields[2]!,'');await fill(resultFields[3]!,'提案資料を作成する');
  expect((await db.read(project.id))!.nextSteps).toEqual([]); // typing is not confirmation
  await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  await settle(()=>expect(done).toHaveBeenCalledOnce());
  await act(async()=>root.unmount());root=createRoot(host);
  const clock=vi.spyOn(Date,'now').mockReturnValue(Date.now()+86400000);
  await act(async()=>root.render(<Projects initialId={project.id} onBack={()=>{}} onStart={start} privacyMode="strict_local"/>));
  await settle(()=>expect(host.textContent).toContain('提案資料を作成する'));await settle(()=>expect(host.textContent).toContain('予算を確認する'));
  await act(async()=>button('この案件の続きから話す').click());await settle(()=>expect(start).toHaveBeenCalledTimes(2));
  expect(start.mock.calls[1]![0].decisions).toEqual(['予算確認の担当は私']);clock.mockRestore();
  await act(async()=>button('案件メモを削除').click());await act(async()=>button('メモを削除する').click());
  await settle(()=>expect(host.querySelector('[aria-label="保存済みの案件メモ"]')?.textContent).not.toContain('予算確認の担当は私'));
  expect(await new TaskWorkspace(`ai-meeting-project-tasks-${project.id}`).read()).toHaveLength(1);
  await act(async()=>button('この案件の続きから話す').click());await settle(()=>expect(start).toHaveBeenCalledTimes(3));
  expect(projectContext(start.mock.calls[2]![0])).not.toContain('予算確認の担当は私');
 } finally {await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();}
});
