import { useState } from "react";
import type { Settings, SettingsAction } from "../state/settings.js";

/** Endpoints + dev toggles only. There is intentionally no API key field (spec §26). */
export function SettingsScreen({ settings, dispatch, onBack }: { settings: Settings; dispatch: (a: SettingsAction) => void; onBack: () => void }) {
  const [broker, setBroker] = useState(settings.brokerUrl);
  const [agent, setAgent] = useState(settings.agentUrl);
  return (
    <div className="settings">
      <div className="card">
        <div className="card__eyebrow">設定</div>
        <h2 className="card__title">接続先</h2>
        <div className="card__grid">
          <div className="field">
            <label>トークンブローカー</label>
            <input className="input" value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="http://localhost:8787" />
          </div>
          <div className="field">
            <label>ローカルエージェント（WebSocket）</label>
            <input className="input" value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="ws://localhost:8788" />
          </div>
          <div className="toggle">
            <div className="toggle__label"><b>遅延の表示</b><span>会話画面に遅延の実測値を出します（開発用）。</span></div>
            <button type="button" className={`switch ${settings.showHud ? "is-on" : ""}`} onClick={() => dispatch({ type: "hud", on: !settings.showHud })} />
          </div>
          <p className="radio__meta">API キーはクライアントに保存しません。キーは services/token-broker の環境変数で設定します。</p>
        </div>
        <div className="card__actions">
          <button type="button" className="btn btn--ghost" onClick={() => dispatch({ type: "reset" })}>初期化</button>
          <button type="button" className="btn btn--primary" onClick={() => { dispatch({ type: "urls", brokerUrl: broker.trim(), agentUrl: agent.trim() }); onBack(); }}>保存して戻る</button>
        </div>
      </div>
    </div>
  );
}
