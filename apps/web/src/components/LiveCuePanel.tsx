import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveCueScheduler, type LiveCue, type CueIntent, type ConversationTask } from '@rcai/conversation-core';
import type { Caption } from '../session/useSession.js';
import { cueCandidates, remoteCueProvider } from '../session/liveCueClient.js';
import { ProjectWorkspace, type ProjectNote } from '../state/projectWorkspace.js';
import '../styles/live-cues.css';

export interface LiveCuePanelProps {
  transcript?: string; captions: Caption[]; tasks: ConversationTask[]; projectId?: string;
  active: boolean; brokerUrl: string; privacyMode: 'default' | 'strict_local'; team?: boolean;
  onCue?: (intent: CueIntent) => void;
}
const labels: Record<CueIntent, string> = { none: '関連するメモ', explore: 'アイデアを考える', compare: '選択肢を比べる', clarify: '内容を確かめる', plan: '次の一歩を考える', acknowledge: 'ありがとうを受け取る' };
const kinds = { task: 'タスク', decision: '保存済みの決定', question: '未解決の問い', next_step: '次の一歩' };

/** Parallel reading only: no ledger write, tool invocation or spoken response is reachable here. */
export function LiveCuePanel(p: LiveCuePanelProps) {
  const [enabled, setEnabled] = useState(true);
  const [animate, setAnimate] = useState(() => typeof window !== 'undefined' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const [project, setProject] = useState<ProjectNote | null>(null);
  const [noteError, setNoteError] = useState(false);
  const [cue, setCue] = useState<LiveCue | null>(null);
  const [token, setToken] = useState('');
  const [consent, setConsent] = useState(false);
  const [consentBroker, setConsentBroker] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const scheduler = useRef<LiveCueScheduler | null>(null);
  const latest = p.captions.filter(c => c.role === 'user').at(-1);
  const text = (p.transcript ?? latest?.text ?? '').trim().slice(-800);
  const cloudAllowed = p.privacyMode !== 'strict_local' && !p.team;

  useEffect(() => { setConsent(false); setToken(''); }, [p.brokerUrl, p.privacyMode, p.team]);
  useEffect(() => {
    let alive = true; setProject(null); setNoteError(false);
    if (p.projectId && p.active && enabled) void new ProjectWorkspace().read(p.projectId).then(x => { if (alive) setProject(x); }).catch(() => { if (alive) setNoteError(true); });
    return () => { alive = false; };
  }, [p.projectId, latest?.id, p.active, enabled]);

  const candidates = useMemo(() => cueCandidates(p.tasks, project, text), [p.tasks, project, text]);
  const key = JSON.stringify(candidates);
  const remote = cloudAllowed && consent && consentBroker === p.brokerUrl && /^[^\s]{32,512}$/.test(token);
  const provider = useMemo(() => remote ? remoteCueProvider({ brokerUrl: p.brokerUrl, token, consent, privacyMode: p.privacyMode, team: !!p.team }) : undefined,
    [remote, p.brokerUrl, token, consent, p.privacyMode, p.team]);
  useEffect(() => {
    setFallback(false);
    if (!p.active || !enabled) { setCue(null); return; }
    let alive = true;
    const current = new LiveCueScheduler({ provider,
      onCue: x => { if (alive) { setCue(x); if (x?.source === 'jev') setFallback(false); } },
      onFallback: () => { if (alive) setFallback(true); },
    });
    scheduler.current = current;
    return () => { alive = false; current.dispose(); if (scheduler.current === current) scheduler.current = null; };
  }, [p.active, enabled, provider]);
  useEffect(() => {
    if (!p.active || !enabled) return;
    if (text) scheduler.current?.submit({ text, candidates: JSON.parse(key) });
    else scheduler.current?.clear();
  }, [text, key, p.active, enabled, provider]);
  useEffect(() => { p.onCue?.(enabled && animate && p.active && cue ? cue.intent : 'none'); }, [cue, enabled, animate, p.active, p.onCue]);
  useEffect(() => () => { p.onCue?.('none'); }, [p.onCue]);
  const selected = candidates.find(x => x.id === cue?.candidateId);

  return <aside className="live-cues" aria-label="会話に合わせたヒント" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
    <details>
      <summary>会話ヒント <span>{!enabled ? 'オフ' : cue?.source === 'jev' ? 'Jev' : remote && !fallback ? 'Jev接続待ち' : 'ローカル'}</span></summary>
      <div className="live-cues__settings">
        <label><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />話している途中も、関連するメモを表示</label>
        <label><input type="checkbox" checked={animate} onChange={e => setAnimate(e.target.checked)} />会話内容に表情を合わせる</label>
        <p>ヒントは参考表示です。タスク保存・予定登録・承認は行いません。</p>
        {cloudAllowed ? <details><summary>Jevを接続する（任意）</summary>
          <p>現在の発話テキスト（最大800文字）と候補メモ（最大12件）を、次の接続先経由でTypeSafeへ送ります。音声や会話全文は送りません。</p>
          <code>{p.brokerUrl}</code>
          <label>専用の接続トークン<input type="password" value={token} maxLength={512} autoComplete="off" onChange={e => { setConsent(false); setToken(e.target.value); }} placeholder="管理者が発行した判断専用トークン" /></label>
          <label><input type="checkbox" checked={consent} onChange={e => { setConsentBroker(p.brokerUrl); setConsent(e.target.checked); }} />送信先と内容を確認し、この会話中の送信に同意する</label>
          <p>TypeSafeのAPIキーは入力しないでください。トークンと同意は保存せず、接続設定変更時に消去します。公開・チーム提供ではJevは無効です。</p>
        </details> : <p>このモードのヒントは端末内で処理します。Jevへの送信は行いません。</p>}
      </div>
    </details>
    {enabled && p.active && <div className="live-cues__body">
      {selected ? <><small>{kinds[selected.kind]} · 参考</small><p className="live-cues__title">{selected.label}</p></> : <p className="live-cues__empty">{text ? '一致するメモが見つかると、ここに表示します。' : '話題に合うメモが、会話中にここへ。'}</p>}
      {cue && cue.intent !== 'none' && <small>{labels[cue.intent]}</small>}
      {fallback && <p className="live-cues__notice" role="status">Jevを利用できないため、ローカル照合で続けています。</p>}
      {noteError && <p className="live-cues__notice">案件メモを読み込めません。会話とタスクはそのまま使えます。</p>}
    </div>}
  </aside>;
}
