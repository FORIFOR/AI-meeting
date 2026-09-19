import type { SessionOutcome } from '../session/SessionController.js';
import type { ProjectNote } from '../state/projectWorkspace.js';
import { ProjectEditor } from '../components/ProjectEditor.js';
import '../styles/projects.css';
export function ProjectResult({outcome,project,onDone}:{outcome:SessionOutcome;project:ProjectNote;onDone:()=>void}) {
  return <main className="projects-page"><p className="workspace-label">REVIEW BEFORE SAVING</p><h1>決まったことだけ、次回へ。</h1><p>「{project.title}」の前回のメモを表示しています。今回決まったことと未決事項を分けて確認してください。</p>
    <details><summary>今回の会話を確認する（全文は保存しません）</summary>{outcome.record.turns.map((t,i)=><p key={i}><strong>{t.role==='user'?'あなた':'AI'}</strong> {t.text}</p>)}</details>
    {!!outcome.tasks?.length&&<section><h2>保存したタスク</h2><ul>{outcome.tasks.map(t=><li key={t.id}>{t.title} · {t.status==='done'?'完了':t.status==='deferred'?'延期':'未完了'}{t.due?` · ${t.due}`:''}</li>)}</ul></section>}
    {!!outcome.unconfirmedTaskChanges && <p role="status">未確認の変更案が{outcome.unconfirmedTaskChanges}件ありました。これらは保存していません。</p>}
    <ProjectEditor project={project} onSaved={onDone} onCancel={onDone}/>
  </main>;
}
