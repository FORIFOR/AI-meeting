import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { hostedAuth } from '../api/hostedAuth.js';

export function HostedAccount({ seconds, daily, onChange }: { seconds: number; daily: number; onChange: (ready: boolean) => void }) {
  const [user, setUser] = useState<User | null>(null), [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false), [signup, setSignup] = useState(false);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [message, setMessage] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false, unsubscribe: (() => void) | undefined;
    void Promise.all([hostedAuth(), import('firebase/auth')]).then(([auth, sdk]) => {
      if (cancelled) return;
      unsubscribe = sdk.onIdTokenChanged(auth, value => { setUser(value); onChange(value?.emailVerified === true); });
    }).catch(() => { if (!cancelled) setError('ログインに接続できません。時間をおいて、ページを再読み込みしてください。'); });
    return () => { cancelled = true; unsubscribe?.(); onChange(false); };
  }, [onChange]);
  const act = async (fn: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(''); setMessage('');
    try { await fn(); }
    catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'auth/too-many-requests' ? '操作が続いたため、少し時間をおいてお試しください。' : code === 'auth/weak-password' ? 'パスワードは8文字以上で設定してください。' : '手続きを完了できませんでした。メールアドレスとパスワードを確認してください。');
    } finally { setBusy(false); }
  };
  return <section className="hosted-account" aria-label="音声体験のアカウント" style={{ maxWidth: 984, margin: '16px auto', padding: '16px 24px', border: '1px solid #dce3d9', borderRadius: 16 }}>
    <div style={{ display: 'flex', gap: 16, justifyContent: 'space-between', flexWrap: 'wrap', alignItems: 'center' }}><div><strong>ログインして、声で整理する。</strong><p style={{ fontSize: 12, margin: '6px 0' }}>音声体験は1回{Math.floor(seconds / 60)}分・1日{daily}回まで（UTC日付で集計）。提供枠に限りがあります。自動課金はありません。</p></div><button className="btn" onClick={() => setOpen(!open)}>{user ? 'アカウント' : 'ログイン・登録'}</button></div>
    {open && (user ? <div><p>{user.email}</p>{!user.emailVerified && <><p>確認メールのリンクを開いた後、確認状況を更新してください。</p><button className="btn" disabled={busy} onClick={() => void act(async () => { await user.reload(); await user.getIdToken(true); onChange(user.emailVerified); setUser(user); setMessage(user.emailVerified ? '確認できました。音声体験を始められます。' : 'メールの確認がまだ完了していません。'); })}>メールの確認状況を更新</button><button className="btn" disabled={busy} onClick={() => void act(async () => { const sdk = await import('firebase/auth'); await sdk.sendEmailVerification(user); setMessage('確認メールを送信しました。'); })}>確認メールを再送</button></>}
      <button className="btn btn--ghost" disabled={busy} onClick={() => void act(async () => { const sdk = await import('firebase/auth'); await sdk.signOut(await hostedAuth()); setOpen(false); })}>ログアウト</button>
      <button className="btn btn--ghost" disabled={busy} onClick={() => void act(async () => { if (!window.confirm('ログイン用のアカウントを削除しますか？端末のタスクは残ります。')) return; const sdk = await import('firebase/auth'); await sdk.deleteUser(user); setMessage('アカウントを削除しました。'); })}>アカウントを削除</button>
    </div> : <form onSubmit={e => { e.preventDefault(); void act(async () => { const sdk = await import('firebase/auth'), auth = await hostedAuth(); if (signup) { const result = await sdk.createUserWithEmailAndPassword(auth, email, password); await sdk.sendEmailVerification(result.user); setMessage('確認メールを送信しました。リンクを開いて登録を完了してください。'); } else { await sdk.signInWithEmailAndPassword(auth, email, password); } setPassword(''); }); }}>
      <p>メールアドレスはログインと本人確認に使用します。音声体験では音声・発話・利用するタスクをGoogleの音声AIへ送ります。利用枠の管理記録をサーバーに保持します。</p>
      <label style={{ display: 'block', margin: '12px 0' }}>メールアドレス<input className="input" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label><label style={{ display: 'block', margin: '12px 0' }}>パスワード<input className="input" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} maxLength={128} required value={password} onChange={e => setPassword(e.target.value)} /></label>
      <button className="btn btn--primary" disabled={busy}>{signup ? '登録して確認メールを受け取る' : 'ログイン'}</button><button className="btn" type="button" onClick={() => setSignup(!signup)}>{signup ? 'ログインに戻る' : '新規登録'}</button><button className="btn btn--ghost" type="button" disabled={busy || !email} onClick={() => void act(async () => { const sdk = await import('firebase/auth'); await sdk.sendPasswordResetEmail(await hostedAuth(), email); setMessage('登録済みの場合、パスワード再設定メールが届きます。'); })}>パスワードを再設定</button>
    </form>)}
    {message && <p role="status">{message}</p>}{error && <p className="err" role="alert">{error}</p>}
  </section>;
}
