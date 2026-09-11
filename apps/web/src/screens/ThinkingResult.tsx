import { useState } from 'react';
import type { SessionOutcome } from '../session/SessionController.js';
import { saveConversationMemory } from '../state/conversationMemory.js';
export function ThinkingResult({outcome,onHome,onAgain}:{outcome:SessionOutcome;onHome:()=>void;onAgain:()=>void}) {
 const [conclusion,setConclusion]=useState(''),[nextStep,setNextStep]=useState(''),[status,setStatus]=useState('');
 return <main className="result thinking-result"><p className="home__greet">話してくれて、ありがとう。</p><h1>今日の一歩を、残しておこう。</h1><p>決まったことがなくても大丈夫。今の考えを、短く残せます。</p>
 {outcome.liveUsage && <p>GPT-Live 1：{Math.ceil(outcome.liveUsage.seconds)}秒利用（{outcome.liveUsage.finalized ? "集計済み" : "暫定・終了確認なし"}）</p>}
 <form onSubmit={e=>{e.preventDefault();const ok=saveConversationMemory({characterId:outcome.record.characterId ?? 'yui',conclusion,nextStep,at:Date.now()});setStatus(ok?'この端末に保存しました。次回「続きから話す」で使えます。':'保存できませんでした。内容をコピーして残してください。');}}>
 <label>今日話したこと・決まったこと<textarea maxLength={1200} value={conclusion} onChange={e=>setConclusion(e.target.value)} placeholder="自分の言葉で、ひとこと" /></label>
 <label>次の小さな一歩<textarea maxLength={1200} value={nextStep} onChange={e=>setNextStep(e.target.value)} placeholder="まだ決めていなければ、空欄で大丈夫" /></label>
 <p className="empty">保存したメモだけを次回の会話に引き継げます。ホームで削除できます。</p><button className="btn btn--primary" disabled={!conclusion.trim()&&!nextStep.trim()}>確認して保存する</button><p role="status">{status}</p></form>
 <details className="disc"><summary>会話を振り返る</summary>{outcome.record.turns.map((t,i)=><p key={i}><strong>{t.role==='user'?'あなた':'相手'}</strong> {t.text}</p>)}</details>
 <div className="actions"><button className="btn" onClick={onAgain}>新しく話す</button><button className="btn btn--primary" onClick={onHome}>ホームへ</button></div></main>;
}
