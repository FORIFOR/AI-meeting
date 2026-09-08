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
  { mode: "english_lesson", kana: "English Conversation", name: "英会話", desc: "会話中は訂正しない。気づきはあとでまとめて渡す。" },
  { mode: "free_talk", kana: "Free Talk", name: "雑談", desc: "話題は自由。間や相槌の自然さを確かめる。" },
  { mode: "sales_roleplay", kana: "Sales Roleplay", name: "営業ロープレ", desc: "顧客役と商談。反論への返し方を試す。" },
  { mode: "tutor", kana: "Tutor", name: "学習", desc: "問いかけで理解を確かめながら進める。" },
  { mode: "career", kana: "Career", name: "キャリア相談", desc: "話しながら考えを整理する。" },
  { mode: "companion", kana: "Companion", name: "寄り添い", desc: "評価も助言もしない。近しい相手として、ただ聞く。" },
  { mode: "task_planning", kana: "Tasks", name: "タスク整理", desc: "頭の中のやることを話して出す。相手が覚えて、最初の一歩を一緒に決める。" },
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
      <p className="home__greet">{greeting()}</p>
      <h1 className="home__ask">何を練習しますか？</h1>
      <div className="acts">
        {items.map((x) => (
          <button key={x.mode} type="button" className="act" disabled={!!blocked} onClick={() => p.onContinue(x.mode)}>
            {x.name}
            <span className="act__note">{RELEASE_LABEL[RELEASE_POLICY.modes[x.mode]]}</span>
          </button>
        ))}
        {p.onMeeting && stageAvailable(RELEASE_POLICY.meeting, RELEASE_CHANNEL) && (
          <button type="button" className="act" disabled={!!blocked || strict} onClick={p.onMeeting}>
            会議
            <span className="act__note">Google Meet · Zoom ベータ · Teams 未対応</span>
          </button>
        )}
      </div>

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
