import type { ProviderId } from "@rcai/conversation-core";
import { PROVIDER_LABEL, type Availability, type Settings, type SettingsAction } from "../state/settings.js";

const PROVIDERS: ProviderId[] = ["openai", "google", "local"];

export interface SessionSheetProps {
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  availability: Availability;
  characterName: string;
  providerId: ProviderId | null;
  live: boolean;
  gateOn: boolean;
  onGate: (on: boolean) => void;
  onProvider: (id: ProviderId) => void;
  onClose: () => void;
}

/**
 * Level 2/3 for the conversation screen. Nothing here is visible while talking;
 * it appears only when the ··· is opened, and closes on any choice.
 */
export function SessionSheet(p: SessionSheetProps) {
  const strict = p.settings.privacyMode === "strict_local";
  return (
    <div className="sheet" role="dialog" aria-label="セッション設定">
      <div className="rows">
        <button type="button" className="row" onClick={() => p.dispatch({ type: "captions", on: !p.settings.captionsOn })}>
          <span className="row__label">字幕</span>
          <span className="row__value">{p.settings.captionsOn ? "表示" : "非表示"}</span>
        </button>
        <button type="button" className="row" onClick={() => p.dispatch({ type: "camera", on: !p.settings.cameraOn })}>
          <span className="row__label">自分のカメラ</span>
          <span className="row__value">{p.settings.cameraOn ? "表示" : "非表示"}</span>
        </button>
        <div className="row">
          <span className="row__label">相手</span>
          <span className="row__value">{p.characterName}</span>
        </div>
        <div className="row">
          <span className="row__label">エンジン</span>
          <span className="row__value">
            <select
              className="select"
              value={p.providerId ?? ""}
              disabled={!p.live}
              onChange={(e) => { p.onProvider(e.target.value as ProviderId); p.onClose(); }}
            >
              {PROVIDERS.map((id) => (
                <option key={id} value={id} disabled={strict && id !== "local"}>
                  {PROVIDER_LABEL[id]}
                </option>
              ))}
            </select>
          </span>
        </div>
      </div>

      <p className="group__title">開発者</p>
      <div className="rows">
        <div className="row">
          <span className="row__label">遅延の表示</span>
          <button type="button" className={`switch ${p.settings.showHud ? "is-on" : ""}`} aria-pressed={p.settings.showHud} onClick={() => p.dispatch({ type: "hud", on: !p.settings.showHud })} />
        </div>
        <div className="row">
          <span className="row__label">評価パネル</span>
          <button type="button" className={`switch ${p.gateOn ? "is-on" : ""}`} aria-pressed={p.gateOn} onClick={() => { p.onGate(!p.gateOn); p.onClose(); }} />
        </div>
      </div>
    </div>
  );
}
