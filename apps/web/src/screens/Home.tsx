import { CreditBalance } from "../components/CreditBalance.js";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import type { BrokerHealth, AgentHealth } from "../api/health.js";
import { blockedReason } from "../components/characters.js";
import type { CharacterEntry } from "../integrations/registry.js";
import type { Settings, SettingsAction } from "../state/settings.js";
import { whenLabel, type Recent } from "../state/recent.js";
import { RELEASE_POLICY, RELEASE_LABEL, stageAvailable } from "@rcai/conversation-core";
import { RELEASE_CHANNEL } from "../content/release.js";

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
  onMeeting?: () => void;
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
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  return (
    <div className="home">
      <section className="home__hero" aria-labelledby="home-title">
        <div className="home__intro">
          <p className="home__greet">{greeting()}</p>
          <h1 id="home-title" className="home__ask">今日は、何を話しますか？</h1>
          <p className="home__lede">相手と目的を選ぶだけで、すぐに始められます。</p>
        </div>
        <aside className="home__companion" aria-label="選択中の相手">
          <div className="home__avatar" aria-hidden="true">{character?.name?.slice(0, 1) ?? "?"}</div>
          <div className="home__companion-copy">
            <span className="home__overline">話す相手</span>
            <strong>{character?.name ?? "準備中"}</strong>
            <span>{blocked ? "接続を確認中" : "いつでも話せます"}</span>
          </div>
          <button type="button" className="btn btn--ghost home__change" onClick={p.onCharacter}>変更</button>
        </aside>
      </section>

      <section className="home__setup" aria-label="会話を準備">
        <div className="home__section-head">
          <div>
            <p className="home__step">STEP 1</p>
            <h2>話す相手</h2>
          </div>
          <label className="sr-only" htmlFor="home-character">話す相手を選択</label>
          <select id="home-character" className="select home__character-select" value={character?.id ?? ""} onChange={e => p.dispatch({ type: "character", id: e.target.value })}>
            {p.characters.map(c => <option key={c.id} value={c.id} disabled={!!blockedReason(c, p.broker, strict)}>{c.name}</option>)}
          </select>
        </div>
        <div className="home__section-head home__section-head--purpose">
          <div>
            <p className="home__step">STEP 2</p>
            <h2>目的を選ぶ</h2>
          </div>
          <p className="hint">あとから声や話し方も変えられます</p>
        </div>
        <div className="acts">
        {items.map((x) => (
          <button key={x.mode} type="button" className="act" disabled={!!blocked} onClick={() => p.onContinue(x.mode)}>
            <span className="act__icon" aria-hidden="true">{x.name.slice(0, 1)}</span>
            <span className="act__name">{x.name}</span>
            <small className="act__note">{x.desc}</small>
            <span className="act__note">{RELEASE_LABEL[RELEASE_POLICY.modes[x.mode]]}</span>
          </button>
        ))}
        {p.onMeeting && stageAvailable(RELEASE_POLICY.meeting, RELEASE_CHANNEL) && (
          <button type="button" className="act" disabled={!!blocked || strict} onClick={p.onMeeting}>
            <span className="act__icon" aria-hidden="true">会</span>
            <span className="act__name">会議</span>
            <span className="act__note">Google Meet · Zoom ベータ · Teams 未対応</span>
          </button>
        )}
      </div>
      </section>

      <details className="home__credits">
        <summary><span><b>利用状況</b><small>残りのクレジットと料金を確認</small></span><span className="home__details-chevron" aria-hidden="true">›</span></summary>
        <CreditBalance enabled={!strict} />
      </details>

      {p.contentNote && <p className="notice">{p.contentNote}</p>}
      {offline && (
        <p className="notice" role="status">
          {import.meta.env.VITE_RCAI_CLOUD === "true" ? (
            <span>サービスへの接続を確認しています。しばらく待っても接続できない場合は、ページを再読み込みしてください。</span>
          ) : (<>
          <b>ローカルサービスが起動していません。</b>
          {desktop ? "デスクトップ版はサービスを同梱していません（beta）。" : ""}
          <br />
          <code>scripts/local-stack.sh start &amp;&amp; pnpm dev</code>
          </>)}
        </p>
      )}

      <hr className="home__rule" />
      {p.recent && available.has(p.recent.mode) ? (
        <button type="button" className="cont" onClick={() => p.onContinue(p.recent!.mode)}>
          <span>
            前回のつづき — <b>{p.recent.characterName}</b> · {MODE_NAME[p.recent.mode] ?? p.recent.mode} · {whenLabel(p.recent.at)}
          </span>
          <span className="row__chev">›</span>
        </button>
      ) : (
        <p className="cont cont--empty">
          <span>話しかければ、聞いている顔をする。</span>
        </p>
      )}

      <div className="home__foot">
        <button type="button" className="btn btn--ghost" onClick={p.onCharacter}>
          相手 · {character?.name ?? "—"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={p.onSettings}>
          設定
        </button>
      </div>
    </div>
  );
}
