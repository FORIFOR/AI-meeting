import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConversationTask, PrivacyMode } from '@rcai/conversation-core';
import { ProjectWorkspace, type ProjectNote } from '../state/projectWorkspace.js';
import { TaskWorkspace } from '../state/taskWorkspace.js';
import { Tasks } from './Tasks.js';
import { ProjectEditor } from '../components/ProjectEditor.js';
import { CalendarActions } from '../components/CalendarActions.js';
import '../styles/projects.css';
const projects = new ProjectWorkspace();
export function Projects({initialId,onStart,onBack,privacyMode}:{initialId?:string;onStart?:(p:ProjectNote)=>Promise<void>;onBack:()=>void;privacyMode:PrivacyMode}) {
  const [list,setList]=useState<ProjectNote[]>([]),[selected,setSelected]=useState<ProjectNote|null>(null);
  const [editing,setEditing]=useState(false),[creating,setCreating]=useState(false),[removing,setRemoving]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [task,setTask]=useState<ConversationTask|undefined>();
  const tasks=useMemo(()=>selected?new TaskWorkspace(`ai-meeting-project-tasks-${selected.id}`):undefined,[selected?.id]);
  const load=useCallback(async()=>{const rows=await projects.list();setList(rows);},[]);
  useEffect(()=>{let alive=true;void projects.list().then(rows=>{if(!alive)return;setList(rows);setSelected(rows.find(p=>p.id===initialId)??null);}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[initialId]);
  const save=(p:ProjectNote)=>{setSelected(p);setEditing(false);setCreating(false);void load().catch(e=>setError(e.message));};
  const start=async()=>{if(!selected||!onStart||busy)return;setBusy(true);setError('');try{const fresh=await projects.read(selected.id);if(!fresh)throw new Error('案件が削除されています。');await onStart(fresh);}catch(e){setError(e instanceof Error?e.message:'会話を開始できませんでした。');}finally{setBusy(false);}};
  return <div className="projects-page">
    <header className="projects-heading"><div><p className="workspace-label">CONTINUE YOUR WORK</p><h1>{selected?.title??'続きから、考えよう。'}</h1><p>キャラクターを変えても、確認した仕事の続きから。</p></div><button className="btn" onClick={onBack}>ホームへ</button></header>
    <p role="alert" className="err">{error}</p>
    {(creating||editing)?<ProjectEditor key={creating?'new':selected!.id} project={creating?undefined:selected!} onSaved={save} onCancel={()=>{setCreating(false);setEditing(false);}}/>:!selected?<>
      <button className="btn btn--primary" onClick={()=>setCreating(true)}>新しい案件を作る</button>
      <ul className="project-grid">{list.map(p=><li key={p.id}><button onClick={()=>{setSelected(p);setTask(undefined);}}><strong>{p.title}</strong><span>{p.goal||'目標はこれから。'}</span><small>{new Date(p.updatedAt).toLocaleDateString('ja-JP')}に保存 · 未決 {p.openQuestions.length}件</small></button></li>)}</ul>
    </>:<>
      <div className="actions"><button className="btn" onClick={()=>{setSelected(null);setTask(undefined);void load().catch(e=>setError(e.message));}}>案件一覧へ</button><button className="btn btn--primary" disabled={!onStart||busy} onClick={()=>void start()}>この案件の続きから話す</button><button className="btn" onClick={()=>setEditing(true)}>メモを確認・編集</button><button className="btn" onClick={()=>setRemoving(true)}>案件メモを削除</button></div>
      {!onStart&&<p>音声AIの接続を確認すると、この案件の続きから話せます。メモとタスクの編集は利用できます。</p>}
      <p className="tasks-storage">「この案件の続きから話す」を押すと、この案件の保存済みメモとタスクを、設定で選んだ音声AIに共有します。他の案件は共有しません。</p>
      <section className="project-notes" aria-label="保存済みの案件メモ"><div><h2>目標</h2><p>{selected.goal||'未設定'}</p></div>{([['決まったこと',selected.decisions],['まだ決まっていないこと',selected.openQuestions],['次の一歩',selected.nextSteps]] as const).map(([title,items])=><div key={title}><h2>{title}</h2>{items.length?<ul>{items.map((x,i)=><li key={i}>{x}</li>)}</ul>:<p>まだありません。</p>}</div>)}</section>
      {removing&&<section className="task-review"><h2>案件のメモを削除しますか？</h2><p>タスクと実行履歴、Google側の予定は削除しません。タスクのバックアップは下の欄から保存できます。</p><button className="btn" onClick={()=>{void projects.save({title:selected.title,goal:'',decisions:[],openQuestions:[],nextSteps:[]},selected).then(p=>{setSelected(p);setRemoving(false);return load();}).catch(e=>setError(e.message));}}>メモを削除する</button><button className="btn" onClick={()=>setRemoving(false)}>取り消す</button></section>}
      <Tasks key={selected.id} store={tasks} onBack={()=>setSelected(null)} onTalk={onStart?()=>void start():undefined} onSchedule={setTask} description={`「${selected.title}」のタスク。他の案件とは分けて保存します。`} />
      <CalendarActions key={`calendar-${selected.id}`} projectId={selected.id} task={task} privacyMode={privacyMode} onDrafted={()=>setTask(undefined)}/>
    </>}
    <p className="tasks-storage">このブラウザーに保存します。端末間の同期はありません。削除したメモは次回の会話へ渡しません。</p>
  </div>;
}
