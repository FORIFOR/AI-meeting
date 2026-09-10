import { readConversationMemory, forgetConversationMemory } from "../state/conversationMemory.js";
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
  onResume?: () => void;
  onTalk?: () => void;
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
  const [memoryVersion, setMemoryVersion] = useState(0);
  const memory = readConversationMemory(character?.id ?? "yui");
  const [meetingUrl, setMeetingUrl] = useState("");
  const portrait = character && ["yui", "haru", "reina", "sora"].includes(character.id) ? `/avatar-fallbacks/${character.id}.png` : null;
  return (
    <main className="home workspace-home">
      <section className="workspace-welcome">
        <div><p className="home__greet">{greeting()}</p><h1>今日は、誰と話しますか？</h1><p>まとまっていなくても大丈夫。話しながら、一緒に考えましょう。</p></div>
        <span className="workspace-badge">THINKING MEETING</span>
      </section>
      <div className="workspace-grid">
        <section className="thinking-launch" aria-labelledby="launch-title">
          <span className="workspace-label">A LITTLE SPACE TO THINK</span>
          <h2 id="launch-title">話すうちに、<br />次の一歩が見えてくる。</h2>
          <p>{character?.name ?? "AI"}と、アイデアも、迷っていることも。<br />会議URLは必要ありません。</p>
          <button className="btn btn--primary btn--lg" disabled={!!blocked || !p.onTalk} onClick={p.onTalk}>{character?.name ?? "AI"}と話す <span aria-hidden="true">↗</span></button>
          <p className="thinking-launch__hint">マイクを許可して、そのまま話しかけてください。</p>
          {memory && <div className="thinking-memory" key={memoryVersion}><p>前回のメモ：{memory.conclusion || memory.nextStep}</p><button className="btn" disabled={!!blocked} onClick={p.onResume}>続きから話す</button><button className="btn btn--ghost" onClick={() => { forgetConversationMemory(memory.characterId); setMemoryVersion(v=>v+1); }}>メモを削除</button></div>}
          <div className="thinking-prompts"><span>「このアイデア、どう思う？」</span><span>「今日やることを整理したい」</span><span>「まだうまく言えないけれど…」</span></div>
        </section>
        <aside className="companion-feature" aria-label="選択中の相手">
          <div className="companion-feature__heading"><span className="workspace-label">YOUR PARTNER</span><span className="companion-feature__tag">{character ? RENDERER_JA[character.renderer] : "準備中"}</span></div>
          <div className="companion-feature__portrait">{portrait ? <img src={portrait} alt={`${character?.name}の外見`} /> : <span className="companion-feature__placeholder">プレビューで外見を確認</span>}</div>
          <div className="companion-feature__bottom"><div><h2>{character?.name ?? "相手を選択"}</h2><p>{blocked ? "利用状況は選択画面で確認" : "あなたの会議パートナー"}</p></div><button className="btn" onClick={p.onCharacter}>相手を選ぶ ↗</button></div>
        </aside>
      </div>
      <div className="workspace-support">
        <CreditBalance enabled={!strict} />
        <section className="workspace-guide"><span className="workspace-label">INVITE YOUR PARTNER</span><h2>いつもの会議にも。</h2><p>Google Meet・Zoomに、{character?.name ?? "AI"}を招待できます。</p><form onSubmit={e => { e.preventDefault(); p.onMeeting?.(meetingUrl.trim()); }}><label htmlFor="home-meeting-url">会議の招待リンク</label><input className="input" id="home-meeting-url" type="url" value={meetingUrl} onChange={e => setMeetingUrl(e.target.value)} placeholder="https://meet.google.com/…" /><button className="btn btn--ghost" disabled={strict || !p.onMeeting} type="submit">会議に呼ぶ →</button></form></section>
      </div>
      <details className="workspace-modes"><summary>英会話・面接練習など、目的を決めて話す</summary><section aria-labelledby="modes-title"><div className="workspace-section-head"><div><span className="workspace-label">MORE WAYS TO TALK</span><h2 id="modes-title">目的に合わせて。</h2></div><p>練習も、考えの整理も。あなたのペースで。</p></div>
        <div className="acts">{items.map((x) => <button key={x.mode} type="button" className="act" disabled={!!blocked} onClick={() => p.onContinue(x.mode)}><span className="act__icon" aria-hidden="true">{({ interview: "◎", english_lesson: "Aa", free_talk: "◌", sales_roleplay: "↗", tutor: "◇", career: "⌁", companion: "♡", task_planning: "☑" }[x.mode])}</span><span className="act__name">{x.name}</span><small className="act__note">{x.desc}</small></button>)}</div>
      </section>
      </details>
      {p.contentNote && <p className="notice">{p.contentNote}</p>}
      {offline && <p className="notice" role="status">サービスへの接続を確認しています。接続できない場合は設定をご確認ください。</p>}
      <footer className="workspace-footer">{p.recent && available.has(p.recent.mode) ? <button className="btn btn--ghost" onClick={() => p.onContinue(p.recent!.mode)}>もう一度話す · {p.recent.characterName} · {whenLabel(p.recent.at)} →</button> : <span>あなたの会話から、次の一歩へ。</span>}<button className="btn btn--ghost" onClick={p.onSettings}>音声・接続の設定</button></footer>
    </main>
  );
}
