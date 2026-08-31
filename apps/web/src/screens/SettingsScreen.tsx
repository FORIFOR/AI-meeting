import { useState } from "react";
import type { ProviderId } from "@rcai/conversation-core";
import type { AutoPolicy, EngineSelection, Role } from "@rcai/provider-core";
import { POLICY_LABEL, PROVIDER_LABEL, ROLE_LABEL, decide, type Availability, type Settings, type SettingsAction } from "../state/settings.js";
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
  characters: CharacterEntry[];
  onCharacter: () => void;
  onBack: () => void;
}

/** Grouped rows — no cards, no explanatory paragraphs. Level 3 lives under 詳細設定. */
export function SettingsScreen({ settings, dispatch, availability, characters, onCharacter, onBack }: SettingsProps) {
  const [broker, setBroker] = useState(settings.brokerUrl);
  const [agent, setAgent] = useState(settings.agentUrl);
  const strict = settings.privacyMode === "strict_local";
  const character = characters.find((c) => c.id === settings.characterId) ?? characters[0];
  const decision = decide(settings, availability ?? undefined);

  return (
    <div className="page">
      <p className="page__eyebrow">設定</p>
      <h1 className="page__title">会話のしかた</h1>

      <div className="group">
        <p className="group__title">会話</p>
        <div className="rows">
          <div className="row">
            <span className="row__label">エンジン</span>
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
