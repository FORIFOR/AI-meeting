// Node 22+: node --experimental-transform-types --loader ./tests/task-storage.loader.mjs --test tests/task-storage.regression.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PersistentTaskLedger } from '../apps/web/src/state/taskWorkspace.ts';
import { TaskLedger } from '../packages/conversation-core/src/tasks.ts';
class StorageFixture {
  tasks=[]; fail=false;
  async read() { return structuredClone(this.tasks); }
  async change(fn) {
    const next=fn(structuredClone(this.tasks));
    if(this.fail) throw new Error('transaction aborted');
    this.tasks=structuredClone(next.tasks);
    return next.result;
  }
}
const add=(title='資料を作る')=>({operations:[{action:'add',title,quote:title}]});
test('failed apply cannot appear as a saved task in the live snapshot',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store); store.fail=true;
  await assert.rejects(()=>ledger.apply(add(),'資料を作る'));
  assert.deepEqual(ledger.snapshot(),[]); assert.deepEqual(store.tasks,[]);
});
test('confirmation survives an aborted write and can be retried explicitly',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store);
  const {proposal}=await ledger.propose(add()); store.fail=true;
  await assert.rejects(()=>ledger.resolve(proposal.id,true));
  assert.equal(ledger.pending()[0].id,proposal.id); assert.deepEqual(ledger.snapshot(),[]);
  store.fail=false; const result=await ledger.resolve(proposal.id,true);
  assert.equal(result.tasks.length,1); assert.equal(store.tasks.length,1); assert.deepEqual(ledger.pending(),[]);
});
test('failed rejection does not silently discard a pending proposal',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store);
  const {proposal}=await ledger.propose(add()); store.fail=true;
  await assert.rejects(()=>ledger.resolve(proposal.id,false)); assert.equal(ledger.pending().length,1);
});
test('successful rejection saves no task',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store);
  const {proposal}=await ledger.propose(add()); await ledger.resolve(proposal.id,false);
  assert.deepEqual(ledger.pending(),[]); assert.deepEqual(store.tasks,[]);
});
test('ledger copies do not consume the original proposal',()=>{
  const original=new TaskLedger(); const {proposal}=original.propose(add()); const staged=original.copy();
  staged.resolve(proposal.id,true); assert.equal(original.pending().length,1); assert.deepEqual(original.snapshot(),[]);
});
test('copy preserves monotonic proposal identifiers',()=>{
  const original=new TaskLedger(); const first=original.propose(add()).proposal;
  const staged=original.copy(); const second=staged.propose(add('メールを送る')).proposal;
  assert.notEqual(first.id,second.id); assert.equal(original.pending().length,1);
});
test('stale updates still cannot overwrite a newer user edit',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store); await ledger.apply(add(),'資料を作る');
  const {proposal}=await ledger.propose({operations:[{action:'update',id:store.tasks[0].id,status:'done',quote:'資料を作る作業が終わった'}]});
  store.tasks[0].status='deferred'; const result=await ledger.resolve(proposal.id,true);
  assert.ok(result.error); assert.equal(store.tasks[0].status,'deferred');
});
test('a proposal arriving during a pending write is not overwritten by the staged ledger',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store);
  const first=(await ledger.propose(add())).proposal;
  let release, entered; const begun=new Promise(resolve=>{entered=resolve});
  const gate=new Promise(resolve=>{release=resolve});
  const change=store.change.bind(store);
  store.change=async fn=>{const result=await change(fn);entered();await gate;return result;};
  const saved=ledger.resolve(first.id,true); await begun;
  const later=ledger.propose(add('メールを送る')); release();
  await saved; const second=(await later).proposal;
  assert.equal(ledger.pending()[0].id,second.id); assert.equal(ledger.snapshot().length,1);
});
test('a failed transaction does not block the next queued request',async()=>{
  const store=new StorageFixture(), ledger=new PersistentTaskLedger(store); store.fail=true;
  await assert.rejects(()=>ledger.apply(add(),'資料を作る')); store.fail=false;
  const result=await ledger.apply(add(),'資料を作る'); assert.equal(result.tasks.length,1);
});
