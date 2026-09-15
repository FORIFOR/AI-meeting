// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { TaskLedger } from '@rcai/conversation-core';
import { TaskList } from './TaskList.js';
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

function pendingLedger() {
  const ledger = new TaskLedger();
  ledger.apply({operations:[{action:'add',title:'牛乳を買う',quote:'牛乳を買う'}]},'牛乳を買う');
  ledger.propose({operations:[{action:'update',id:'task-1',status:'done',quote:'もう買いました'}]});
  return ledger;
}

it('shows pending proposals without inert approval buttons in a read-only view',async()=>{
  const ledger=pendingLedger();
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try {
    await act(async()=>root.render(<TaskList tasks={ledger.snapshot()} proposals={ledger.pending()}/>));
    expect(host.textContent).toContain('閲覧専用');
    expect(host.textContent).toContain('まだ反映していません');
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(ledger.snapshot()[0]?.status).toBe('pending');
    expect(ledger.pending()).toHaveLength(1);
  } finally { await act(async()=>root.unmount());host.remove(); }
});

it('announces task and proposal counts independently as review resolves',async()=>{
  const ledger=pendingLedger();
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  const render=()=>root.render(<TaskList tasks={ledger.snapshot()} proposals={ledger.pending()} onResolve={(id,accept)=>{ledger.resolve(id,accept);render();}}/>);
  try {
    await act(async()=>render());
    const summary=()=>host.querySelector('[role="status"]');
    expect(summary()?.getAttribute('aria-live')).toBe('polite');
    expect(summary()?.getAttribute('aria-atomic')).toBe('true');
    expect(summary()?.textContent).toContain('タスク 1件');
    expect(summary()?.textContent).toContain('確認待ちの変更案 1件');
    await act(async()=>{(host.querySelector('button') as HTMLButtonElement).click();});
    expect(summary()?.textContent).toContain('確認待ちの変更案 0件');
    expect(host.querySelector('.task-review')).toBeNull();
    expect(ledger.snapshot()[0]?.status).toBe('done');
  } finally { await act(async()=>root.unmount());host.remove(); }
});
