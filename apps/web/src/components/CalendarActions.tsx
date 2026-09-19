import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationTask, PrivacyMode } from '@rcai/conversation-core';
import { CalendarActionStore, CalendarExecutor, localDateTimeToIso, type CalendarAction } from '../state/calendarActions.js';
import { authorizeCalendar, prepareCalendarAuthorization, GoogleCalendarAdapter, type CalendarCredential } from '../api/googleCalendar.js';
const labels = {draft:'確認待ち',approved:'承認済み・未確認',executing:'実行中・未確認',verified:'登録を確認済み',failed:'失敗',unknown:'結果不明・再確認が必要',cancelled:'取り消し済み'};
const store = new CalendarActionStore();
const format = (s:string) => new Date(s).toLocaleString('ja-JP', {timeZoneName:'short'});
export function CalendarActions({ projectId, task, privacyMode, onDrafted, clientId = import.meta.env.VITE_GOOGLE_CALENDAR_CLIENT_ID ?? '' }: {
  projectId:string; task?:ConversationTask; privacyMode:PrivacyMode; onDrafted?:()=>void; clientId?:string;
}) {
  const [actions,setActions] = useState<CalendarAction[]>([]), [credential,setCredential] = useState<CalendarCredential|null>(null);
  const [prepared,setPrepared] = useState(false), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const [start,setStart] = useState(''), [end,setEnd] = useState('');
  const allowed = useRef(privacyMode !== 'strict_local'), controller = useRef(new AbortController()), mounted = useRef(true);
  allowed.current = privacyMode !== 'strict_local';
  const reload = useCallback(async () => { const rows = await store.list(projectId); if (mounted.current) setActions(rows); }, [projectId]);
  useEffect(() => {
    mounted.current = true; allowed.current = privacyMode !== 'strict_local'; controller.current = new AbortController();
    const load = () => { void reload().catch(e=> {if(mounted.current)setError(String(e.message));}); }; load();
    window.addEventListener('focus',load);
    return () => { mounted.current=false; allowed.current=false; controller.current.abort(); window.removeEventListener('focus',load); };
  },[reload]);
  useEffect(() => { if(privacyMode === 'strict_local') { controller.current.abort(); setCredential(null); } else controller.current = new AbortController(); },[privacyMode]);
  useEffect(() => { setStart('');setEnd(''); },[task?.id]);
  const run = async (work:()=>Promise<unknown>) => {
    if(busy)return;setBusy(true);setError('');
    try { await work(); await reload(); } catch(e) { if(mounted.current)setError(e instanceof Error?e.message:'操作を完了できませんでした。'); }
    finally { if(mounted.current)setBusy(false); }
  };
  const adapter = () => {
    if (!credential) throw new Error('登録案と同じGoogleアカウントで接続してください。');
    return new GoogleCalendarAdapter(credential,()=>allowed.current,fetch,controller.current.signal);
  };
  return <section className="project-calendar" aria-label="カレンダーへの登録と実行履歴">
    <h2>予定にする</h2><p>確認した予定だけを、自分のGoogleカレンダーに登録します。参加者の招待やメール送信は行いません。</p>
    <p className="tasks-storage">Googleには選んだ予定のタイトル・日時と実行IDを送信します。案件のメモや会話全文は送信しません。接続情報はこの画面を離れると破棄します。</p>
    {privacyMode === 'strict_local' ? <p>ローカル限定モードでは外部接続できません。</p> : !clientId ? <p>カレンダー接続は未設定です。運営者がGoogle OAuthクライアントIDを設定すると利用できます。</p> : !prepared ?
      <button className="btn" disabled={busy} onClick={()=>void run(async()=>{await prepareCalendarAuthorization(allowed.current);if(mounted.current)setPrepared(true);})}>送信先を確認して接続を準備</button> :
      <div className="actions"><button className="btn" disabled={busy} onClick={()=>void run(async()=>{const authSignal=controller.current.signal;const value=await authorizeCalendar(clientId,allowed.current,authSignal);if(!authSignal.aborted&&mounted.current&&allowed.current)setCredential(value);})}>{credential?'Googleに再接続':'Googleアカウントを選択'}</button>{credential&&<><span>{credential.account.email}</span><button className="btn" disabled={busy} onClick={()=>{controller.current.abort();controller.current=new AbortController();setCredential(null);}}>この画面の接続を解除</button></>}</div>}
    {task && <form aria-label="予定の登録案" className="project-form" onSubmit={e=>{e.preventDefault();void run(async()=>{
      if(!credential||!allowed.current)throw new Error('Googleに接続してください。');
      const a=localDateTimeToIso(start), b=localDateTimeToIso(end);
      await store.draft({title:task.title,start:a,end:b,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,projectId,taskId:task.id},credential.account);
      onDrafted?.();
    });}}>
      <h3>{task.title}</h3>{task.due&&<p>発話の期限（原文）：{task.due}。自動変換せず、下の日時を確認してください。</p>}
      <p>入力時刻：{Intl.DateTimeFormat().resolvedOptions().timeZone}</p>
      <label>開始日時<input type="datetime-local" value={start} onChange={e=>setStart(e.target.value)} required /></label>
      <label>終了日時<input type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)} required /></label>
      <button className="btn" disabled={busy||!credential||!allowed.current}>登録案を作る（まだ送信しません）</button>
    </form>}
    <p role="alert" className="err">{error}</p>
    <h3>実行履歴</h3><p>結果不明の操作は自動再送しません。再接続後は同じ実行IDで照会します。</p>
    {!actions.length&&<p>登録案はまだありません。</p>}
    <ul className="project-action-list">{actions.map(action=><li key={action.id}>
      <strong>{action.payload.title}</strong><span role="status">{labels[action.state]}</span>
      <p>{format(action.payload.start)} 〜 {format(action.payload.end)}</p><p>登録先：{action.account.email} のメインカレンダー</p>
      <details><summary>実行記録</summary><p>ID：{action.id}</p><p>作成：{format(new Date(action.createdAt).toISOString())}</p>{action.approvedAt&&<p>承認：{format(new Date(action.approvedAt).toISOString())}</p>}{action.verifiedAt&&<p>照合：{format(new Date(action.verifiedAt).toISOString())}</p>}</details>
      {action.error&&<p>{action.error}</p>}
      {action.state==='draft'&&<div className="actions"><button className="btn btn--primary" disabled={busy||!credential||!allowed.current} onClick={()=>void run(()=>new CalendarExecutor(store,()=>allowed.current).approve(action,adapter()))}>この内容を承認してGoogleに登録</button><button className="btn" disabled={busy} onClick={()=>void run(()=>store.change(action,{state:'cancelled'}))}>登録案を取り消す</button></div>}
      {['unknown','executing','approved'].includes(action.state)&&<button className="btn" disabled={busy||!credential||!allowed.current} onClick={()=>void run(()=>new CalendarExecutor(store,()=>allowed.current).reconcile(action,adapter()))}>登録結果を再確認（再送しません）</button>}
    </li>)}</ul>
    <p className="tasks-storage">実行履歴はこのブラウザーに保存します。接続解除はGoogle側の権限取消とは異なります。権限の取消はGoogleアカウントの接続済みアプリから行ってください。</p>
  </section>;
}
