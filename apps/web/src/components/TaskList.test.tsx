// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { TaskLedger } from '@rcai/conversation-core';
import { TaskList } from './TaskList.js';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
for(const accept of [true,false])it(`review button ${accept?'applies':'cancels'} a mistranscribed change`,async()=>{
 const ledger=new TaskLedger();
 ledger.apply({operations:[{action:'add',title:'牛乳を買う',quote:'牛乳を買う'}]},'牛乳を買う');
 ledger.propose({operations:[{action:'update',id:'task-1',status:'done',quote:'もう買いました'}]});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const render=()=>root.render(<TaskList tasks={ledger.snapshot()} proposals={ledger.pending()} onResolve={(id,yes)=>{ledger.resolve(id,yes);render();}}/>);
 try {
  await act(async()=>render());
  expect(host.textContent).toContain('まだ反映していません');
  expect(ledger.snapshot()[0]?.status).toBe('pending');
  await act(async()=>{(host.querySelectorAll('button')[accept?0:1] as HTMLButtonElement).click();});
  expect(ledger.snapshot()[0]?.status).toBe(accept?'done':'pending');
  expect(host.querySelector('.task-review')).toBeNull();
  expect(host.textContent).toContain(`${accept?'完了':'未完了'} · 牛乳を買う`);
 } finally { await act(async()=>root.unmount());host.remove(); }
});
