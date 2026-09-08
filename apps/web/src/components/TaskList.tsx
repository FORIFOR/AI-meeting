import type { ConversationTask, TaskProposal } from '@rcai/conversation-core';
export function TaskList({tasks,proposals=[],onResolve}:{tasks:ConversationTask[];proposals?:TaskProposal[];onResolve?:(id:string,accept:boolean)=>void}) {
  return <section className="task-ledger" aria-label="記録したタスク" onClick={e=>e.stopPropagation()}>
    <h2>記録したタスク</h2>
    {tasks.length ? <ul>{tasks.map(t=><li key={t.id}>
      <span>{t.status==='done'?'完了':t.status==='deferred'?'延期':'未完了'} · {t.title}</span>
      {t.due&&<small>期限: {t.due}</small>}
    </li>)}</ul> : <p>記録されたタスクはありません。会話の記録も確認してください。</p>}
    {proposals.map(p=><div className="task-review" key={p.id}>
      <h3>聞き取りの確認</h3><p>まだ反映していません。この内容でよいですか？</p>
      <ul>{p.changes.map(t=><li key={t.id}>{t.title} → {t.status==='done'?'完了':t.status==='deferred'?'延期':'未完了'}{t.due&&`（期限: ${t.due}）`}</li>)}</ul>
      <button type="button" onClick={()=>onResolve?.(p.id,true)}>この変更を反映</button>{' '}
      <button type="button" onClick={()=>onResolve?.(p.id,false)}>取り消す</button>
    </div>)}
  </section>;
}
