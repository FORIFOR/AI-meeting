import { useState } from 'react';
import { ProjectWorkspace, type ProjectNote } from '../state/projectWorkspace.js';
const store = new ProjectWorkspace();
const lines = (s:string) => s.split('\n').map(x=>x.trim()).filter(Boolean);
export function ProjectEditor({project,onSaved,onCancel}:{project?:ProjectNote;onSaved:(x:ProjectNote)=>void;onCancel:()=>void}) {
  const [title,setTitle]=useState(project?.title??''),[goal,setGoal]=useState(project?.goal??'');
  const [decisions,setDecisions]=useState(project?.decisions.join('\n')??''),[open,setOpen]=useState(project?.openQuestions.join('\n')??''),[next,setNext]=useState(project?.nextSteps.join('\n')??'');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  return <form className="project-form" aria-label="案件メモを確認して保存" onSubmit={e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');void store.save({title:title.trim(),goal:goal.trim(),decisions:lines(decisions),openQuestions:lines(open),nextSteps:lines(next)},project).then(onSaved).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>
    <label>案件名<input value={title} onChange={e=>setTitle(e.target.value)} maxLength={160} required /></label>
    <label>目標<textarea value={goal} onChange={e=>setGoal(e.target.value)} maxLength={1200} /></label>
    <label>決まったこと（1行に1件）<textarea value={decisions} onChange={e=>setDecisions(e.target.value)} maxLength={18000} /></label>
    <label>まだ決まっていないこと（1行に1件）<textarea value={open} onChange={e=>setOpen(e.target.value)} maxLength={18000} /></label>
    <label>次の一歩（1行に1件）<textarea value={next} onChange={e=>setNext(e.target.value)} maxLength={18000} /></label>
    <p>確認して保存したメモだけを次回へ引き継ぎます。録音や会話全文は保存しません。</p><p role="alert" className="err">{error}</p>
    <div className="actions"><button className="btn btn--primary" disabled={busy||!title.trim()}>確認して案件に保存</button><button type="button" className="btn" disabled={busy} onClick={onCancel}>保存せず戻る</button></div>
  </form>;
}
