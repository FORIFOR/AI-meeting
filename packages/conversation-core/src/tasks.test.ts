import {describe,it,expect} from 'vitest';
import {TaskLedger} from './tasks.js';
describe('explicit session tasks',()=>{
 it('rejects transcription variants of existing tasks without changing their original text',()=>{
  const s=new TaskLedger();
  const original='ＡＩ 資料確認';
  s.apply({operations:[{action:'add',title:original,quote:original}]},original);
  const repeated='AI資料 確認';
  expect(s.apply({operations:[{action:'add',title:repeated,quote:repeated}]},repeated).error).toBe('task already exists; update its id');
  expect(s.snapshot()).toEqual([{id:'task-1',title:original,status:'pending'}]);
  expect(s.propose({operations:[{action:'add',title:repeated,quote:repeated}]}).error).toBe('task already exists; update its id');
  expect(s.pending()).toEqual([]);
 });
 it('rejects malformed status values atomically instead of coercing them to an enum',()=>{
  const s=new TaskLedger();
  s.apply({operations:[{action:'add',title:'資料確認',quote:'資料確認'}]},'資料確認');
  for(const status of [['done'],null,{},0,true]) {
   const result=s.apply({operations:[{action:'add',title:'返信',quote:'返信'}, {action:'update',id:'task-1',status,quote:'完了'}]},'返信、完了');
   expect(result.error).toBe('unknown status');
   expect(s.snapshot()).toEqual([{id:'task-1',title:'資料確認',status:'pending'}]);
  }
 });
 it('preserves the parent action and deadline when prerequisites and completion arrive',()=>{
  const s=new TaskLedger();
  const quote='15時までに見積書を送る、牛乳を買う、領収書を整理する';
  s.apply({operations:[{action:'add',title:'見積書を送る',due:'15時まで',quote},{action:'add',title:'牛乳を買う',quote},{action:'add',title:'領収書を整理する',quote}]},quote);
  const update='牛乳はもう買いました。領収書は明日に回します。見積書の前に金額を確認する必要があります。';
  expect(s.apply({operations:[{action:'update',id:'task-2',status:'done',quote:update},{action:'update',id:'task-3',status:'deferred',due:'明日',quote:update},{action:'add',title:'金額を確認する',quote:update}]},update).error).toBeUndefined();
  const pending=s.apply({operations:[]},'残りを教えて').tasks.filter(t=>t.status==='pending');
  expect(pending.map(t=>t.title)).toEqual(['見積書を送る','金額を確認する']);
  expect(pending[0]?.due).toBe('15時まで');
 });
 it('rejects invented deadlines, stale quotations and incomplete batches without mutations',()=>{
  const s=new TaskLedger(),quote='資料を作る';
  expect(s.apply({operations:[{action:'add',title:quote,quote,due:'明日'}]},quote).error).toBeDefined();
  expect(s.apply({operations:[{action:'add',title:quote,quote}]},'それは取り消して').error).toBeDefined();
  expect(s.apply({operations:[{action:'add',title:quote,quote},{action:'update',id:'missing',quote}]},quote).error).toBeDefined();
  expect(s.snapshot()).toEqual([]);
 });
 it('does not share tasks across conversations or expose mutable state',()=>{
  const s=new TaskLedger();s.apply({operations:[{action:'add',title:'買う',quote:'買う'}]},'買う');s.snapshot()[0]!.title='changed';
  expect(s.snapshot()[0]?.title).toBe('買う');expect(new TaskLedger().snapshot()).toEqual([]);
 });
});
it('retains a directly quoted clock deadline despite omitted tool metadata and STT spaces',()=>{
 const s=new TaskLedger();const quote='15時までに見積書を送る、牛乳を買う';
 s.apply({operations:[{action:'add',title:'見積書を送る',quote},{action:'add',title:'牛乳を買う',quote}]},'15 時までに 見積書を送る、牛乳を買う');
 expect(s.snapshot()[0]?.due).toBe('15時までに');expect(s.snapshot()[1]?.due).toBeUndefined();
});
it('recovers a mistranscribed change only after explicit confirmation',()=>{
 const s=new TaskLedger();s.apply({operations:[{action:'add',title:'牛乳を買う',quote:'牛乳を買う'}]},'牛乳を買う');
 const args={operations:[{action:'update',id:'task-1',status:'done',quote:'牛乳はもう買いました'}]};
 expect(s.apply(args,'टैक्सी').error).toBeDefined();
 const proposal=s.propose(args).proposal!;
 expect(proposal.changes[0]?.status).toBe('done');
 expect(s.snapshot()[0]?.status).toBe('pending');
 expect(s.propose(args).proposal?.id).toBe(proposal.id);
 expect(s.pending()).toHaveLength(1);
 expect(s.resolve(proposal.id,true).tasks[0]?.status).toBe('done');
 expect(s.pending()).toEqual([]);
 expect(s.resolve(proposal.id,true).error).toBeDefined();
});
it('cancels proposals and refuses stale or invalid changes',()=>{
 const s=new TaskLedger();s.apply({operations:[{action:'add',title:'買う',quote:'買う'}]},'買う');
 const args={operations:[{action:'update',id:'task-1',status:'done',quote:'買いました'}]};
 let id=s.propose(args).proposal!.id;
 s.resolve(id,false);expect(s.snapshot()[0]?.status).toBe('pending');
 id=s.propose(args).proposal!.id;
 s.apply({operations:[{action:'update',id:'task-1',status:'deferred',quote:'延期'}]},'延期');
 expect(s.resolve(id,true).error).toBeDefined();expect(s.snapshot()[0]?.status).toBe('deferred');
 expect(s.propose({operations:[{action:'update',id:'missing',quote:'完了'}]}).error).toBeDefined();
 expect(s.propose({operations:[{action:'add',title:'買う',quote:'買う',due:'明日'}]}).error).toBeDefined();
});
it('accepts repaired real-provider arguments without weakening quote or update-id validation',()=>{
 const s=new TaskLedger();
 const source='タスク 名 は 資料 確認 と メール 返信 です 。 どちら も 期限 は 今日 です 。';
 expect(s.apply({operations:[{action:'add',title:'資料確認',due:'今日',quote:'資料確認'}]},source).error).toBe('due must be quoted, not inferred');
 expect(s.snapshot()).toEqual([]);
 const quote='タスク名は資料確認とメール返信です。どちらも期限は今日です。';
 const added=s.apply({operations:['資料確認','メール返信'].map(title=>({action:'add',title,due:'今日',quote}))},source);
 expect(added.error).toBeUndefined();
 const update='資料確認は完了しました。メール返信は明日に延期してください。';
 expect(s.apply({operations:[{action:'update',title:'資料確認',status:'done',quote:update}]},update).error).toBe('unknown task id');
 expect(s.snapshot().every(t=>t.status==='pending')).toBe(true);
 const result=s.apply({operations:[{action:'update',id:added.tasks[0]!.id,status:'done',quote:update},{action:'update',id:added.tasks[1]!.id,status:'deferred',due:'明日',quote:update}]},update);
 expect(result.error).toBeUndefined();
 expect(result.tasks.map(({title,status,due})=>({title,status,due}))).toEqual([{title:'資料確認',status:'done',due:'今日'},{title:'メール返信',status:'deferred',due:'明日'}]);
});
