import { useCallback, useEffect, useState } from 'react';
import type { ConversationTask } from '@rcai/conversation-core';
import { TaskWorkspace, parseTaskBackup, type TaskBackup } from '../state/taskWorkspace.js';
import '../styles/tasks.css';

const workspace = new TaskWorkspace();
const label = { pending: '未完了', done: '完了', deferred: '延期' };

export function Tasks({ onTalk, onBack, voiceHint, storageDescription, description, showResources = false, store = workspace }: {
  onTalk?: () => void; onBack: () => void; voiceHint?: string; storageDescription?: string; description?: string; showResources?: boolean; store?: TaskWorkspace;
}) {
  const [tasks, setTasks] = useState<ConversationTask[]>([]);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState('');
  const [showStarNudge, setShowStarNudge] = useState(false);
  const [title, setTitle] = useState(''), [due, setDue] = useState('');
  const [filter, setFilter] = useState<'active' | 'done' | 'all'>('active');
  const [editing, setEditing] = useState<ConversationTask | null>(null);
  const [editTitle, setEditTitle] = useState(''), [editDue, setEditDue] = useState('');
  const [removing, setRemoving] = useState<ConversationTask | null>(null);
  const [backup, setBackup] = useState<TaskBackup | null>(null);
  const fail = (e: unknown) => { setMessage(''); setError(e instanceof Error ? e.message : 'タスクを読み込めませんでした。'); };
  const refresh = useCallback(async () => { const next = await store.read(); setTasks(next); setReady(true); }, [store]);
  useEffect(() => {
    const load = () => { void refresh().catch(fail); };
    load(); window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [refresh]);
  const mutate = async (action: () => Promise<void>, success: string) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); await refresh(); setMessage(success); }
    catch (e) { fail(e); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const exportBackup = async () => {
    try {
      const current = await store.read();
      const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, tasks: current }, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `ai-meeting-tasks-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage('バックアップをダウンロードしました。');
    } catch (e) { fail(e); }
  };
  const visible = tasks.filter(t => filter === 'all' || (filter === 'done' ? t.status === 'done' : t.status !== 'done'));
  const remaining = tasks.filter(t => t.status !== 'done').length;

  return <main className="tasks-page">
    <div className="tasks-heading"><div><p className="workspace-label">YOUR NEXT STEP</p><h1>今日の一歩を、ここに。</h1><p>{description ?? '会話で決めたことも、ふと思いついたことも。'}</p></div><div className="tasks-heading__actions">{showResources && <a className="tasks-star tasks-star--top" href="https://github.com/FORIFOR/AI-meeting" target="_blank" rel="noopener noreferrer" aria-label="GitHubでAI MeetingをStarする（新しいタブ）">GitHubでStarする ↗</a>}<button className="btn" onClick={onBack}>ホームへ</button></div></div>
    <section className="tasks-summary"><div><strong>{remaining}</strong><span>これからのタスク</span><small>{tasks.filter(t => t.status === 'done').length}件完了</small></div><div><button className="btn btn--primary" onClick={onTalk} disabled={!onTalk || !ready || busy}>声でタスクを整理する ↗</button><p>{voiceHint ?? '保存したタスクを引き継いで話せます。'}</p></div></section>
    <p className="tasks-storage">{storageDescription ?? 'このブラウザーに自動保存します。ほかの端末には同期されません。大切なタスクはバックアップできます。音声で整理を始めると、保存したタスクを選択中のAIに共有します。'}</p>
    {error && <div className="notice err" role="alert">{error} <button className="btn btn--ghost" onClick={() => { setError(''); void refresh().catch(fail); }}>読み直す</button></div>}
    <p className="tasks-status" role="status">{message || (!ready && !error ? 'タスクを読み込んでいます…' : '')}</p>
    {showStarNudge && <p className="tasks-nudge" role="status">役立ちそうなら、<a href="https://github.com/FORIFOR/AI-meeting" target="_blank" rel="noopener noreferrer">GitHubでStarする ↗</a>と、あとで見つけやすくなります。</p>}
    <form className="task-add" onSubmit={e => { e.preventDefault(); void mutate(async () => { await store.add(title, due); setTitle(''); setDue(''); setShowStarNudge(true); }, 'タスクを保存しました。'); }}>
      <label>やること<input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="例：見積書を送る" maxLength={160} required disabled={busy || !ready} /></label>
      <label>期限（任意）<input className="input" value={due} onChange={e => setDue(e.target.value)} placeholder="例：9月15日 15時" maxLength={80} disabled={busy || !ready} /></label>
      <button className="btn btn--primary" disabled={busy || !ready || !title.trim() || tasks.length >= 100}>追加する</button>
    </form>
    <div className="task-filter" role="group" aria-label="タスクの絞り込み">{(['active','done','all'] as const).map(f => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'active' ? 'これから' : f === 'done' ? '完了' : 'すべて'}</button>)}</div>
    <ul className="task-cards">{visible.map(task => <li key={task.id} className={`task-card task-card--${task.status}`}>
      <button className="task-check" type="button" aria-label={`${task.title}を${task.status === 'done' ? '未完了に戻す' : '完了にする'}`} disabled={busy} onClick={() => void mutate(() => store.update(task, { status: task.status === 'done' ? 'pending' : 'done' }), '変更を保存しました。')}>{task.status === 'done' ? '✓' : '○'}</button>
      <div className="task-card__content"><span className="task-state">{label[task.status]}</span><h2>{task.title}</h2>{task.due && <p>期限：{task.due}{task.dueRecordedAt && <small> · {new Date(task.dueRecordedAt).toLocaleDateString('ja-JP')}に記録</small>}</p>}</div>
      <div className="task-card__actions"><button className="btn btn--ghost" disabled={busy} onClick={() => { setEditing(task); setEditTitle(task.title); setEditDue(task.due ?? ''); }}>編集</button><button className="btn btn--ghost" disabled={busy} onClick={() => void mutate(() => store.update(task, { status: task.status === 'deferred' ? 'pending' : 'deferred' }), '変更を保存しました。')}>{task.status === 'deferred' ? '再開' : '延期'}</button><button className="btn btn--ghost" disabled={busy} aria-label={`${task.title}を削除`} onClick={() => setRemoving(task)}>削除</button></div>
    </li>)}</ul>
    {ready && !visible.length && <div className="tasks-empty"><span aria-hidden="true">✳</span><h2>{tasks.length ? 'この一覧にはまだタスクがありません。' : 'まずは、小さな一歩から。'}</h2><p>{tasks.length ? 'ほかの一覧に切り替えて確認できます。' : '上の欄に、今日やりたいことをひとつ書いてみましょう。'}</p></div>}
    {editing && <form className="task-review" aria-label="タスクを編集" onSubmit={e => { e.preventDefault(); void mutate(async () => { await store.update(editing, { title: editTitle.trim(), due: editDue.trim() }); setEditing(null); }, '変更を保存しました。'); }}><h2>タスクを編集</h2><label>やること<input className="input" value={editTitle} onChange={e => setEditTitle(e.target.value)} maxLength={160} required /></label><label>期限<input className="input" value={editDue} onChange={e => setEditDue(e.target.value)} maxLength={80} /></label><button className="btn btn--primary" disabled={busy || !editTitle.trim()}>保存する</button><button className="btn" type="button" onClick={() => setEditing(null)}>取り消す</button></form>}
    {removing && <section className="task-review" aria-label="削除の確認"><h2>「{removing.title}」を削除しますか？</h2><p>この操作は元に戻せません。</p><button className="btn" disabled={busy} onClick={() => void mutate(async () => { await store.remove(removing); setRemoving(null); }, 'タスクを削除しました。')}>削除する</button><button className="btn" onClick={() => setRemoving(null)}>取り消す</button></section>}
    <details className="tasks-backup"><summary>バックアップと復元</summary><p>JSONファイルで保存します。復元は現在のタスクに追加し、異なる変更を上書きしません。ブラウザーのデータを消す前にバックアップしてください。</p><button className="btn" disabled={!ready || busy} onClick={() => void exportBackup()}>バックアップを保存</button><label className="task-import">バックアップを選択<input type="file" accept=".json,application/json" disabled={!ready || busy} onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; setBackup(null); setError(''); try { if (file.size > 200_000) throw new Error('ファイルが大きすぎます。200KB以下のバックアップを選択してください。'); setBackup(parseTaskBackup(JSON.parse(await file.text()))); } catch (err) { fail(err); } }} /></label>
      {backup && <div className="task-review"><h3>{backup.tasks.length}件を復元</h3><ul>{backup.tasks.slice(0, 5).map(t => <li key={t.id}>{t.title}</li>)}</ul><button className="btn btn--primary" disabled={busy} onClick={() => void mutate(async () => { await store.import(backup); setBackup(null); }, 'バックアップから復元しました。')}>内容を確認して復元</button><button className="btn" onClick={() => setBackup(null)}>取り消す</button></div>}
    </details>
    {showResources && <footer className="tasks-resources">
      <h2>AI Meetingをもっと知る</h2>
      <p>声で整理する流れを実演で確認できます。音声AIの実装に使いたい方は、GitHubからコードをご覧ください。</p>
      <nav aria-label="AI Meetingの実演とソースコード">
        <a href="https://youtu.be/qLenE6R7-nI" target="_blank" rel="noopener noreferrer" aria-label="45秒の操作デモ（YouTube、新しいタブ）">45秒の操作デモ ↗</a>
        <a href="https://github.com/FORIFOR/AI-meeting" target="_blank" rel="noopener noreferrer" aria-label="GitHubでコードを見る（新しいタブ）">GitHubでコードを見る ↗</a>
        <a className="tasks-star" href="https://github.com/FORIFOR/AI-meeting" target="_blank" rel="noopener noreferrer" aria-label="GitHubでAI MeetingをStarする（新しいタブ）">役立ったらGitHubでStarする ↗</a>
        <a href="https://ai-meeting.forifor.chatgpt.site/ja#business" target="_blank" rel="noopener noreferrer" aria-label="導入・カスタマイズの相談（新しいタブ）">導入・カスタマイズの相談 ↗</a>
      </nav>
    </footer>}
  </main>;
}
