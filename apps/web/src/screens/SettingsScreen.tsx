import { LocalSetup } from "../components/LocalSetup.js";
import { useState } from "react";
import type { ProviderId } from "@rcai/conversation-core";
import type { AutoPolicy, EngineSelection, Role } from "@rcai/provider-core";
import { VOICE_OPTIONS, localVoiceOptions } from "@rcai/persona-core";
import { POLICY_LABEL, PROVIDER_LABEL, ROLE_LABEL, chosenVoice, decide, type Availability, type Settings, type SettingsAction } from "../state/settings.js";
import type { CharacterEntry } from "../integrations/registry.js";

const ENGINES: { id: EngineSelection; ja: string }[] = [
  { id: "auto", ja: "自動で選ぶ" },
  { id: "openai", ja: "OpenAI" },
  { id: "google", ja: "Google Gemini" },
  { id: "local", ja: "ローカル" },
];
const ROLES: Role[] = ["conversation", "vision", "transcription", "evaluation"];
const PROVIDERS: ProviderId[] = ["openai", "google", "local"];

export interface SettingsProps {
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  availability: Availability | null;
  /** Local voices depend on the machine; the agent reports the ones actually installed. */
  agentHealth?: { tts?: { voices?: string[] } } | null;
  characters: CharacterEntry[];
  onCharacter: () => void;
  onBack: () => void;
}

/** Grouped rows — no cards, no explanatory paragraphs. Level 3 lives under 詳細設定. */
export function SettingsScreen({ settings, dispatch, availability, agentHealth, characters, onCharacter, onBack }: SettingsProps) {
  const [broker, setBroker] = useState(settings.brokerUrl);
  const [agent, setAgent] = useState(settings.agentUrl);
  const strict = settings.privacyMode === "strict_local";
  const character = characters.find((c) => c.id === settings.characterId) ?? characters[0];
  const decision = decide(settings, availability ?? undefined);
  const voiceOptions = decision.conversation === "local" ? localVoiceOptions(agentHealth?.tts?.voices) : VOICE_OPTIONS[decision.conversation];

  return (
    <div className="page">
      <p className="page__eyebrow">設定</p>
      <h1 className="page__title">会話のしかた</h1>
      <LocalSetup dispatch={dispatch} onReady={onBack} />

      <div className="group">
        <p className="group__title">会話</p>
        <div className="rows">
          <div className="row">
            <span className="row__label">会話AI</span>
            <span className="row__value">
              <select className="select" value={settings.engine} onChange={(e) => dispatch({ type: "engine", engine: e.target.value as EngineSelection })}>
                {ENGINES.map((e) => (
                  <option key={e.id} value={e.id} disabled={strict && e.id !== "local"}>{e.ja}</option>
                ))}
              </select>
            </span>
          </div>
          {settings.engine === "auto" && (
            <div className="row">
              <span className="row__label">選び方</span>
              <span className="row__value">
                <select className="select" value={settings.autoPolicy} onChange={(e) => dispatch({ type: "autoPolicy", policy: e.target.value as AutoPolicy })}>
                  {(Object.keys(POLICY_LABEL) as AutoPolicy[]).map((k) => (
                    <option key={k} value={k} disabled={strict && k !== "offline" && k !== "privacy_first"}>{POLICY_LABEL[k].ja}</option>
                  ))}
                </select>
              </span>
            </div>
          )}
          <div className="row">
            <span className="row__label">
              表情や声色に反応する
              <small>話し方に合わせて応答が変わり、黙っている判断もします。応答は少し遅くなります。</small>
            </span>
            <button
              type="button"
              className={`switch ${settings.expressive ? "is-on" : ""}`}
              aria-pressed={settings.expressive}
              disabled={strict}
              onClick={() => dispatch({ type: "expressive", on: !settings.expressive })}
            />
          </div>
          <div className="row">
            <span className="row__label">
              完全ローカル
              <small>クラウドへ一切送信しません。</small>
            </span>
            <button type="button" className={`switch ${strict ? "is-on" : ""}`} aria-pressed={strict} onClick={() => dispatch({ type: "privacy", mode: strict ? "default" : "strict_local" })} />
          </div>
        </div>
      </div>

      <div className="group">
        <p className="group__title">キャラクター</p>
        <div className="rows">
          <button type="button" className="row" onClick={onCharacter}>
            <span className="row__label">{character?.name ?? "—"}</span>
            <span className="row__value">変更 <span className="row__chev">›</span></span>
          </button>
          <div className="row">
            <span className="row__label">
              声
              <small>{PROVIDER_LABEL[decision.conversation]} で話すときの声。</small>
            </span>
            <span className="row__value">
              <select
                className="select"
                value={chosenVoice(settings, character?.id, decision.conversation) ?? ""}
                onChange={(e) => character && dispatch({ type: "voice", characterId: character.id, providerId: decision.conversation, voiceId: e.target.value || undefined })}
                disabled={!character}
              >
                <option value="">このキャラクターの声</option>
                {voiceOptions.map((v) => (
                  <option key={v.id} value={v.id}>{v.note}（{v.label}）</option>
                ))}
              </select>
            </span>
          </div>
        </div>
      </div>

      <div className="group">
        <p className="group__title">セッション</p>
        <div className="rows">
          <div className="row">
            <span className="row__label">字幕</span>
            <button type="button" className={`switch ${settings.captionsOn ? "is-on" : ""}`} aria-pressed={settings.captionsOn} onClick={() => dispatch({ type: "captions", on: !settings.captionsOn })} />
          </div>
          <div className="row">
            <span className="row__label">自分のカメラ</span>
            <button type="button" className={`switch ${settings.cameraOn ? "is-on" : ""}`} aria-pressed={settings.cameraOn} onClick={() => dispatch({ type: "camera", on: !settings.cameraOn })} />
          </div>
        </div>
      </div>

      <details className="disc">
        <summary>詳細設定</summary>
        <div className="disc__body">
          <div className="group">
            <p className="group__title">役割ごとのエンジン</p>
            <div className="rows">
              {ROLES.map((role) => (
                <div className="row" key={role}>
                  <span className="row__label">{ROLE_LABEL[role].ja}</span>
                  <span className="row__value">
                    <select
                      className="select"
                      value={settings.advanced[role] ?? ""}
                      onChange={(e) => dispatch({ type: "advanced", role, provider: (e.target.value || undefined) as ProviderId | undefined })}
                    >
                      <option value="">自動 — {PROVIDER_LABEL[decision[role]]}</option>
                      {PROVIDERS.map((id) => (
                        <option key={id} value={id} disabled={strict && id !== "local"}>{PROVIDER_LABEL[id]}</option>
                      ))}
                    </select>
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="group">
            <p className="group__title">接続先</p>
            <div className="rows">
              <div className="row">
                <span className="row__label">トークンブローカー</span>
                <span className="row__value"><input className="input" value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="http://localhost:8787" /></span>
              </div>
              <div className="row">
                <span className="row__label">ローカルエージェント</span>
                <span className="row__value"><input className="input" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="ws://localhost:8788" /></span>
              </div>
              <div className="row">
                <span className="row__label">
                  遅延の表示
                  <small>会話画面に実測値を出します。</small>
                </span>
                <button type="button" className={`switch ${settings.showHud ? "is-on" : ""}`} aria-pressed={settings.showHud} onClick={() => dispatch({ type: "hud", on: !settings.showHud })} />
              </div>
            </div>
            <p className="empty" >API キーはクライアントに保存しません。キーは services/token-broker の環境変数で設定します。</p>
          </div>
        </div>
      </details>

      <div className="page__actions">
        <button type="button" className="btn btn--ghost" onClick={() => dispatch({ type: "reset" })}>初期化</button>
        <button type="button" className="btn btn--primary" onClick={() => { dispatch({ type: "urls", brokerUrl: broker.trim(), agentUrl: agent.trim() }); onBack(); }}>
          保存して戻る
        </button>
      </div>
    </div>
  );
}
