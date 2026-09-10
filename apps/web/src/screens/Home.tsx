import { useState } from "react";
import { CreditBalance } from "../components/CreditBalance.js";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import type { BrokerHealth, AgentHealth } from "../api/health.js";
import { blockedReason, RENDERER_JA } from "../components/characters.js";
import type { CharacterEntry } from "../integrations/registry.js";
import type { Settings, SettingsAction } from "../state/settings.js";
import { whenLabel, type Recent } from "../state/recent.js";

export const PRODUCTS: { mode: ConversationMode; kana: string; name: string; desc: string }[] = [
  { mode: "interview", kana: "Interview Practice", name: "面接練習", desc: "職種・企業のスタイル・難易度を決めて、本番と同じ形式で。" },
  { mode: "english_lesson", kana: "English Conversation", name: "英会話", desc: "英語で会話して、あとでアドバイスをもらう。" },
  { mode: "free_talk", kana: "Free Talk", name: "雑談", desc: "今日の出来事や好きなことを、気軽に話す。" },
  { mode: "sales_roleplay", kana: "Sales Roleplay", name: "営業ロープレ", desc: "顧客役と商談。反論への返し方を試す。" },
  { mode: "tutor", kana: "Tutor", name: "学習", desc: "問いかけで理解を確かめながら進める。" },
  { mode: "career", kana: "Career", name: "キャリア相談", desc: "話しながら考えを整理する。" },
  { mode: "companion", kana: "Companion", name: "寄り添い", desc: "評価も助言もしない。近しい相手として、ただ聞く。" },
  { mode: "task_planning", kana: "Tasks", name: "タスク整理", desc: "やることを話して、今日の優先順位を決める。" },
];

export const MODE_NAME: Record<string, string> = Object.fromEntries(PRODUCTS.map((p) => [p.mode, p.name]));

export interface HomeProps {
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  personas: Persona[];
  characters: CharacterEntry[];
  broker: BrokerHealth | null;
  agent: AgentHealth | null;
  contentNote?: string;
  recent: Recent | null;
  onContinue: (mode: ConversationMode) => void;
  onCharacter: () => void;
  onSettings: () => void;
  onMeeting?: (url?: string) => void;
}

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return "こんばんは。";
  if (h < 11) return "おはようございます。";
  if (h < 18) return "こんにちは。";
  return "こんばんは。";
}

/** Level 1 only: one question, a few answers, one continuation. */
export function Home(p: HomeProps) {
  const strict = p.settings.privacyMode === "strict_local";
  const character = p.characters.find((c) => c.id === p.settings.characterId) ?? p.characters[0];
  const blocked = character ? blockedReason(character, p.broker, strict) : "NO_CHARACTER";
  const available = new Set(p.personas.map((x) => x.mode));
  const items = PRODUCTS.filter((x) => available.has(x.mode));
  const offline = !p.broker && !p.agent;
  const [meetingUrl, setMeetingUrl] = useState("");
  const portrait = character && ["yui", "haru", "reina"].includes(character.id) ? `/avatar-fallbacks/${character.id}.png` : null;
  return (
    <main className="home workspace-home">
      <section className="workspace-welcome">
        <div><p className="home__greet">{greeting()}</p><h1>会議に、頼れる相棒を。</h1><p>話すことに集中。AIが、会話のそばにいます。</p></div>
        <span className="workspace-badge">AI MEETING / WORKSPACE</span>
      </section>
      <div className="workspace-grid">
        <section className="meeting-launch" aria-labelledby="launch-title">
          <div className="meeting-launch__top"><span className="workspace-label">START A MEETING</span><span className="platform-pills"><span>Google Meet</span><span>Zoom</span></span></div>
          <h2 id="launch-title">いつもの会議に、<br />AIを招待しましょう。</h2>
          <p>招待リンクを貼り付けて、相手と声を選ぶだけ。</p>
          <form onSubmit={e => { e.preventDefault(); p.onMeeting?.(meetingUrl.trim()); }}>
            <label htmlFor="home-meeting-url">会議の招待リンク</label>
            <div className="meeting-launch__input"><span aria-hidden="true">↗</span><input id="home-meeting-url" type="url" value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/…" autoComplete="off" /><button className="btn btn--primary" type="submit" disabled={!p.onMeeting || strict}>参加の準備 <span aria-hidden="true">→</span></button></div>
          </form>
          <div className="launch-steps"><span><b>01</b> URLを入力</span><span><b>02</b> 相手・声を選択</span><span><b>03</b> 会議に招待</span></div>
          <p className="meeting-launch__note">次の画面で設定を確認してから参加します。</p>
        </section>
        <aside className="companion-feature" aria-label="選択中の相手">
          <div className="companion-feature__heading"><span className="workspace-label">YOUR PARTNER</span><span className="companion-feature__tag">{character ? RENDERER_JA[character.renderer] : "準備中"}</span></div>
          <div className="companion-feature__portrait">{portrait ? <img src={portrait} alt={`${character?.name}の外見`} /> : <span className="companion-feature__placeholder">プレビューで外見を確認</span>}</div>
          <div className="companion-feature__bottom"><div><h2>{character?.name ?? "相手を選択"}</h2><p>{blocked ? "利用状況は選択画面で確認" : "あなたの会議パートナー"}</p></div><button className="btn" onClick={p.onCharacter}>相手を選ぶ ↗</button></div>
        </aside>
      </div>
      <div className="workspace-support">
        <CreditBalance enabled={!strict} />
        <section className="workspace-guide"><span className="workspace-label">FIRST MEETING</span><h2>はじめてでも、かんたん。</h2><p>会議への参加を許可したら、<br /><strong>「{character?.name ?? "Yui"}、聞こえますか？」</strong>と話しかけてみてください。</p><button className="btn btn--ghost" onClick={() => p.onMeeting?.()}>会議の設定を開く →</button></section>
      </div>
      <section className="workspace-modes" aria-labelledby="modes-title"><div className="workspace-section-head"><div><span className="workspace-label">MORE WAYS TO TALK</span><h2 id="modes-title">会議の外でも、話してみる。</h2></div><p>練習も、考えの整理も。あなたのペースで。</p></div>
        <div className="acts">{items.map((x) => <button key={x.mode} type="button" className="act" disabled={!!blocked} onClick={() => p.onContinue(x.mode)}><span className="act__icon" aria-hidden="true">{({ interview: "◎", english_lesson: "Aa", free_talk: "◌", sales_roleplay: "↗", tutor: "◇", career: "⌁", companion: "♡", task_planning: "☑" }[x.mode])}</span><span className="act__name">{x.name}</span><small className="act__note">{x.desc}</small></button>)}</div>
      </section>
      {p.contentNote && <p className="notice">{p.contentNote}</p>}
      {offline && <p className="notice" role="status">サービスへの接続を確認しています。接続できない場合は設定をご確認ください。</p>}
      <footer className="workspace-footer">{p.recent && available.has(p.recent.mode) ? <button className="btn btn--ghost" onClick={() => p.onContinue(p.recent!.mode)}>前回のつづき · {p.recent.characterName} · {whenLabel(p.recent.at)} →</button> : <span>あなたの会話から、次の一歩へ。</span>}<button className="btn btn--ghost" onClick={p.onSettings}>音声・接続の設定</button></footer>
    </main>
  );
}
