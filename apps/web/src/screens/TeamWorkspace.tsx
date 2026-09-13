import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { Persona } from '@rcai/persona-core';
import type { CharacterEntry } from '../integrations/registry.js';
import type { Settings } from '../state/settings.js';
import { hostedAuth } from '../api/hostedAuth.js';
import { TeamClientError, TeamTaskWorkspace, teamRequest, type TeamSnapshot } from '../state/teamWorkspace.js';
import { disposeActiveSession } from '../session/activeSession.js';
import { Tasks } from './Tasks.js';
import '../styles/team.css';
const Session = lazy(() => import('./Session.js').then(m => ({ default: m.Session })));
function initialLink() {
  const [path, query] = location.hash.slice(1).split('?');
  const team = path?.split('/')[1] ?? '';
  const invite = new URLSearchParams(query).get('invite') ?? '';
  return { team: /^team-[a-f0-9]{24}$/.test(team) ? team : '', invite };
}
export function TeamWorkspace({ settings, persona, character, onBack }: { settings: Settings; persona?: Persona; character?: CharacterEntry; onBack: () => void }) {
  const [link] = useState(initialLink), [uid, setUid] = useState('');
  const [code, setCode] = useState(link.team), [name, setName] = useState('');
  const [store, setStore] = useState<TeamTaskWorkspace | null>(null), [snapshot, setSnapshot] = useState<TeamSnapshot | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [live, setLive] = useState(false);
  const [email, setEmail] = useState(''), [memberName, setMemberName] = useState(''), [invitation, setInvitation] = useState(''), [confirm, setConfirm] = useState<'erase' | 'close' | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { if (link.invite) history.replaceState(null, '', `${location.pathname}${location.search}#team/${link.team}`); }, [link]);
  const identity = useRef(''), currentStore = useRef<TeamTaskWorkspace | null>(null);
  const reset = () => { currentStore.current?.close(); currentStore.current = null; setStore(null); setSnapshot(null); setLive(false); setConsent(false); setInvitation(''); setConfirm(null); void disposeActiveSession(); };
  useEffect(() => {
    if (settings.privacyMode === "strict_local") return;
    let alive = true, unsubscribe: (() => void) | undefined;
    void Promise.all([hostedAuth(), import('firebase/auth')]).then(([auth, sdk]) => {
      if (!alive) return;
      unsubscribe = sdk.onIdTokenChanged(auth, user => {
        const next = user?.emailVerified ? user.uid : '';
        if (next !== identity.current) { identity.current = next; reset(); setUid(next); setError(''); setNotice(''); }
      });
    }).catch(() => setError('上のログインからチームを利用できます。'));
    return () => { alive = false; unsubscribe?.(); currentStore.current?.close(); void disposeActiveSession(); };
  }, [settings.privacyMode]);
  const fail = (e: unknown) => {
    setNotice(''); setError(e instanceof Error ? e.message : 'チームに接続できませんでした。');
    if (e instanceof TeamClientError && [401, 403].includes(e.status)) reset();
  };
  const run = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const open = async (team: string, invite = '') => {
    const candidate = new TeamTaskWorkspace(settings.brokerUrl, uid, team);
    try {
      const data = await candidate.request({ action: invite ? 'join' : 'read', ...(invite ? { token: invite } : {}) });
      if (identity.current !== uid) { candidate.close(); return; }
      currentStore.current?.close(); currentStore.current = candidate; setStore(candidate); setSnapshot(data); setConsent(false);
      history.replaceState(null, '', `${location.pathname}${location.search}#team/${team}`);
    } catch (e) { candidate.close(); throw e; }
  };
  useEffect(() => {
    if (!store || live) return;
    let active = true;
    const refresh = () => { if (document.visibilityState === 'visible') void store.request({ action: 'read' }).then(s => { if (active) setSnapshot(s); }).catch(e => { if (active) fail(e); }); };
    const timer = setInterval(refresh, 60000); window.addEventListener('focus', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [store, live]);
  if (settings.privacyMode === "strict_local") return <main className="team-page"><h1>チームはサーバーに保存します。</h1><p>完全ローカル設定ではチームを利用できません。設定でクラウド接続を有効にすると利用できます。</p><button className="btn" onClick={onBack}>ホームへ</button></main>;
  if (live && store && snapshot && persona && character) return <Suspense fallback={<p>会話を準備しています…</p>}><Session
    settings={{ ...settings, engine: 'google', advanced: {}, cameraOn: false, showHud: false }} dispatch={() => {}} availability={{ google: true, openai: false, local: false }} persona={persona} character={character} params={{}}
    taskWorkspace={store} team={{ id: store.team, uid, consent: snapshot.consentVersion }}
    onEnded={() => { setLive(false); setNotice('会話を終了しました。保存されたタスクを下で確認できます。'); }} onAbort={() => setLive(false)}
  /></Suspense>;
  return <div className="team-page">
    <section className="team-intro"><p className="workspace-label">TEAM WORKSPACE · 限定導入</p><h1>話して決める。<br />チームで進める。</h1><p>5名までの共有タスク。1回3分の音声で、次にやることを整理できます。</p><button className="btn" onClick={onBack}>ホームへ</button></section>
    {error && <p role="alert" className="notice err">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!uid ? <p className="notice">上のログイン・登録でメール確認を完了してください。</p> : !store ? <div className="team-entry">
      <form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await teamRequest<{ team: string }>(settings.brokerUrl, uid, 'create', { name }); await open(result.team); }); }}><h2>チームを始める</h2><p>30日間、5名・100タスクまで。作成による請求や自動課金はありません。</p><label>チーム名<input className="input" value={name} onChange={e => setName(e.target.value)} maxLength={60} required /></label><button className="btn btn--primary" disabled={busy}>チームを作成する</button></form>
      <form onSubmit={e => { e.preventDefault(); void run(() => open(code.trim(), link.invite)); }}><h2>招待されたチームを開く</h2><p>招待されたメールアドレスでログインしてください。</p><label>チームコード<input className="input" value={code} onChange={e => setCode(e.target.value)} pattern="team-[a-f0-9]{24}" required /></label><button className="btn" disabled={busy}>チームを開く</button></form>
    </div> : snapshot && <>
      <section className="team-overview"><div><p className="workspace-label">{snapshot.role === 'admin' ? '管理者' : 'メンバー'}</p><h2>{snapshot.name}</h2><p>利用期限：{new Date(snapshot.expiresAt).toLocaleDateString('ja-JP')} · 音声予約 {snapshot.voiceReservations}/20回</p><small>チームコード：{store.team}</small></div><button className="btn" onClick={() => { reset(); history.replaceState(null, '', '#team'); }}>チームを切り替える</button></section>
      <section className="team-consent"><h2>声で整理する前に</h2><p>マイク音声とこのチームのタスクをGoogle Vertex AI（米国リージョン）へ送信します。AI Meetingはチームの録音・文字起こしを保存しません。確定したタスクをサーバーに保存し、利用期限後はアクセスを停止して削除対象にします。機密情報・個人情報を含めずにお試しください。</p><label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} /> 共有する内容を確認し、音声とタスクの送信に同意します。</label><p><small>1人1日1回、チーム1日3回・累計20回、サービス全体で月30回まで。接続失敗も予約に含まれます。上限時は入力によるタスク整理を続けられます。</small></p></section>
      <Tasks key={store.team} store={store} onBack={onBack} onTalk={consent && persona && character ? () => setLive(true) : undefined} voiceHint="上の共有内容への同意後、3分の会話を始められます。" storageDescription="このチームのメンバー間でサーバー保存・共有します。個人用タスクとは別の保存先です。バックアップにはタスクの内容が含まれるため、保管先にご注意ください。" />
      {snapshot.role === 'admin' && <details className="team-admin"><summary>メンバーとデータを管理する</summary>
        <form onSubmit={e => { e.preventDefault(); void run(async () => { const data = await store.request({ action: 'invite', email, name: memberName }); setSnapshot(data); setInvitation(`${location.origin}${location.pathname}#team/${store.team}?invite=${data.invitationToken}`); }); }}><h3>メンバーを招待</h3><p>指定したメールアドレス専用のリンクを作成します。有効期限は48時間、利用は1回限りです。</p><label>表示名<input className="input" value={memberName} onChange={e => setMemberName(e.target.value)} maxLength={40} required /></label><label>メールアドレス<input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} required /></label><button className="btn" disabled={busy}>招待リンクを作成</button></form>
        {invitation && <label>相手に共有するリンク<textarea className="input" readOnly value={invitation} onFocus={e => e.target.select()} /></label>}
        <h3>参加メンバー</h3><ul>{snapshot.members.map((m, index) => <li key={m.id}>{m.role === 'admin' ? '管理者（あなた）' : m.name} · <code>{m.id.slice(0, 10)}</code>{m.role !== 'admin' && <button className="btn" disabled={busy} onClick={() => void run(async () => { setSnapshot(await store.request({ action: 'revoke', member: m.id })); setNotice('アクセス権を取り消しました。接続中の音声も最大20秒で停止します。'); })}>アクセスを取り消す</button>}</li>)}</ul>
        <button className="btn" disabled={busy} onClick={() => void run(async () => { const data = await store.request({ action: 'audit' }); setSnapshot(data); })}>直近100件の操作記録を確認</button>
        {snapshot.audit && <ul className="team-audit">{snapshot.audit.map((a, i) => <li key={i}>{new Date(a.at).toLocaleString('ja-JP')} · {a.action} · {a.actor.slice(0, 10)} · {a.count}件</li>)}</ul>}
        <p>タスクの内容を含まない操作記録は90日で削除対象になります。タスクを消しても操作記録は残ります。</p>
        <button className="btn" disabled={busy} onClick={() => void run(async () => { setSnapshot(await store.request({ action: 'read' })); setConfirm('erase'); })}>すべてのタスクを削除</button><button className="btn" disabled={busy} onClick={() => void run(async () => { setSnapshot(await store.request({ action: 'read' })); setConfirm('close'); })}>チームの利用を終了</button>
        {confirm && <div className="task-review"><h3>{confirm === 'close' ? 'チームを閉鎖し、全タスクとアクセス権を削除しますか？' : '全タスクを削除しますか？'}</h3><p>必要なタスクは先にバックアップしてください。サーバーの復旧用コピーは最大7日残ります。</p><button className="btn" disabled={busy} onClick={() => void run(async () => { await store.request({ action: confirm, revision: snapshot.revision }); if (confirm === 'close') reset(); else { await open(store.team); setNotice('タスクを削除しました。'); } setConfirm(null); })}>確認して{confirm === 'close' ? '利用を終了' : '削除'}する</button><button className="btn" onClick={() => setConfirm(null)}>取り消す</button></div>}
      </details>}
    </>}
  </div>;
}
