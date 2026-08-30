import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import type { BrokerHealth, AgentHealth } from "../api/health.js";
import { CharacterPicker, blockedReason } from "../components/CharacterPicker.jsx";
import { EngineSelector } from "../components/EngineSelector.jsx";
import type { CharacterEntry } from "../integrations/registry.js";
import type { Availability, Settings, SettingsAction } from "../state/settings.js";

export const PRODUCTS: { mode: ConversationMode; kana: string; name: string; desc: string }[] = [
  { mode: "free_talk", kana: "Free Talk", name: "雑談", desc: "キャラクターと気楽に話す。話題は自由。" },
  { mode: "interview", kana: "Interview Practice", name: "面接練習", desc: "職種・企業スタイル・難易度を選んで本番形式で。" },
  { mode: "english_lesson", kana: "English Conversation", name: "英会話", desc: "訂正は後でまとめて。まずは話し続ける。" },
];

export interface HomeProps {
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  personas: Persona[];
  characters: CharacterEntry[];
  availability: Availability | null;
  broker: BrokerHealth | null;
  agent: AgentHealth | null;
  contentNote?: string;
  onContinue: (mode: ConversationMode) => void;
  onSettings: () => void;
  /** P0-1: join a Google Meet / Zoom as the character. */
  onMeeting?: () => void;
}

export function Home(p: HomeProps) {
  const strict = p.settings.privacyMode === "strict_local";
  const selectedChar = p.characters.find((c) => c.id === p.settings.characterId) ?? p.characters[0];
  const charBlocked = selectedChar ? blockedReason(selectedChar, p.broker, strict) : "NO_CHARACTER";
  const modesAvailable = new Set(p.personas.map((x) => x.mode));
  return (
    <div className="home">
      <section className="hero">
        <div className="hero__eyebrow">Realtime Character AI · Stage</div>
        <h1 className="hero__title">
          話しかければ、<br />
          <em>聞いている</em>顔をする。
        </h1>
        <p className="hero__lede">
          低遅延の音声会話と、会話の文脈に反応して動くキャラクター。AIエンジンは OpenAI / Gemini / ローカルを切り替え可能。採点は会話中には出しません。
        </p>
        <div className="hero__rule"><span>Choose a product</span></div>
        <div className="products">
          {PRODUCTS.map((prod) => (
            <button
              key={prod.mode}
              type="button"
              className="product"
              disabled={!modesAvailable.has(prod.mode) || !!charBlocked}
              onClick={() => p.onContinue(prod.mode)}
              title={charBlocked ?? undefined}
            >
              <div className="product__kana">{prod.kana}</div>
              <div className="product__name">{prod.name}</div>
              <div className="product__desc">{prod.desc}</div>
            </button>
          ))}
          {p.onMeeting && (
            <button type="button" className="product product--meeting" disabled={!!charBlocked || strict} onClick={p.onMeeting} title={strict ? "BLOCKED_BY_STRICT_LOCAL" : charBlocked ?? undefined}>
              <div className="product__kana">Join a meeting</div>
              <div className="product__name">会議に参加</div>
              <div className="product__desc">Google Meet / Zoom にキャラクターが参加。呼ばれたときだけ答える。</div>
            </button>
          )}
        </div>
        {p.contentNote && <p className="err" style={{ marginTop: 18 }}>{p.contentNote}</p>}
        {charBlocked && <p className="err" style={{ marginTop: 18 }}>選択中のキャラクターは利用できません: {charBlocked}</p>}
      </section>
      <aside className="panel">
        <div>
          <h3>キャラクター <small>Character</small></h3>
          <CharacterPicker entries={p.characters} selected={selectedChar?.id ?? ""} onSelect={(id) => p.dispatch({ type: "character", id })} broker={p.broker} strict={strict} />
        </div>
        <div>
          <h3>AI エンジン <small>AI Engine</small></h3>
          <EngineSelector settings={p.settings} dispatch={p.dispatch} availability={p.availability} />
        </div>
        <div className="toggle">
          <div className="toggle__label">
            <b>完全ローカル <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>strict_local</span></b>
            <span>クラウドへ一切送信しない。会話・STT・評価すべてローカル。{p.agent ? "" : " (agent offline)"}</span>
          </div>
          <button type="button" className={`switch ${strict ? "is-on" : ""}`} aria-pressed={strict} onClick={() => p.dispatch({ type: "privacy", mode: strict ? "default" : "strict_local" })} />
        </div>
        {!p.broker && !p.agent && (
          <div className="err" role="status" style={{ fontSize: 12, lineHeight: 1.6 }}>
            <b>サービスが起動していません · Local services are offline</b>
            <br />
            {typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
              ? "デスクトップ版はローカルサービスを同梱していません（beta）。リポジトリで次を実行してからこのウィンドウを再読み込みしてください:"
              : "リポジトリで次を実行してください:"}
            <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontFamily: "var(--font-mono)", fontSize: 11 }}>{"scripts/local-stack.sh start && pnpm dev   # or: pnpm reality:human"}</pre>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <span className="radio__meta">
            broker {p.broker ? "●" : "○"} · agent {p.agent ? `● ${p.agent.llm.engine}` : "○"}
          </span>
          <button type="button" className="btn btn--ghost" onClick={p.onSettings}>設定 · Settings</button>
        </div>
      </aside>
    </div>
  );
}
