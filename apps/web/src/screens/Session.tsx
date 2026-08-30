import { useMemo, useRef, useState } from "react";
import type { ProviderId } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import { Captions } from "../components/Captions.jsx";
import { LatencyHud } from "../components/LatencyHud.jsx";
import { SelfCamera } from "../components/SelfCamera.jsx";
import { Toasts } from "../components/Toasts.jsx";
import { HumanGatePanel } from "../components/HumanGatePanel.jsx";
import type { CharacterEntry } from "../integrations/registry.js";
import { pillFor } from "../session/pill.js";
import type { SessionOutcome } from "../session/SessionController.js";
import { useSession } from "../session/useSession.js";
import { PROVIDER_LABEL, type Availability, type Settings, type SettingsAction } from "../state/settings.js";

export interface SessionProps {
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  availability: Availability;
  persona: Persona;
  character: CharacterEntry;
  params: Record<string, string>;
  onEnded: (o: SessionOutcome) => void;
  onAbort: () => void;
}

const PROVIDERS: ProviderId[] = ["openai", "google", "local"];

/** Spec §19 conversation layout. No scores are rendered here, by design. */
export function Session(p: SessionProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const init = useMemo(
    () => ({ settings: p.settings, availability: p.availability, persona: p.persona, character: p.character, params: p.params }),
    // Session identity is fixed at mount; settings changes mid-session go through the in-session menu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.persona.id, p.character.id],
  );
  const s = useSession(init, stageRef, p.onEnded);
  const [menu, setMenu] = useState(false);
  const [gate, setGate] = useState(false);
  const pill = pillFor(s.avatarState, s.status === "starting");
  const strict = p.settings.privacyMode === "strict_local";
  return (
    <div className="session">
      <div className="stage" onClick={s.interrupt} role="button" aria-label="tap to interrupt">
        <div className="stage__mount" ref={stageRef} />
        <div className="stage__floor" />
        {s.status === "starting" && <div className="stage__loading">支度中 — 接続しています</div>}
        {s.status === "error" && (
          <div className="stage__loading">
            <div style={{ textAlign: "center" }}>
              <div className="err" style={{ marginBottom: 14 }}>セッションを開始できませんでした。</div>
              <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); p.onAbort(); }}>ホームへ戻る</button>
            </div>
          </div>
        )}
        <div className={`pill pill--${pill.key}`}>
          <span className="pill__dot" /> {pill.ja} <span>{pill.en}</span>
        </div>
        {s.status === "live" && <div className="stage__hint">画面をタップすると割り込めます</div>}
        {p.settings.showHud && <LatencyHud report={s.latency} providerId={s.providerId} observability={s.observability} />}
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn--ghost" onClick={() => setMenu((m) => !m)}>
            {s.providerId ? PROVIDER_LABEL[s.providerId] : "AI"} ▾
          </button>
          {menu && (
            <div className="menu__panel">
              {PROVIDERS.map((id) => {
                const avail = id === "openai" ? p.availability.openai : id === "google" ? p.availability.google : p.availability.local;
                const disabled = (strict && id !== "local") || s.status !== "live";
                return (
                  <button key={id} type="button" className={`menu__item ${s.providerId === id ? "is-active" : ""}`} disabled={disabled} onClick={() => { setMenu(false); void s.switchProvider(id); }}>
                    <span>{PROVIDER_LABEL[id]}</span>
                    <span className="menu__meta">{strict && id !== "local" ? "strict" : avail ? "ready" : "?"}</span>
                  </button>
                );
              })}
              <button type="button" className="menu__item" onClick={() => p.dispatch({ type: "hud", on: !p.settings.showHud })}>
                <span>遅延の表示</span>
                <span className="menu__meta">{p.settings.showHud ? "on" : "off"}</span>
              </button>
              <button type="button" className="menu__item" onClick={() => { setMenu(false); setGate((g) => !g); }}>
                <span>評価パネル</span>
                <span className="menu__meta">{gate ? "on" : "off"}</span>
              </button>
            </div>
          )}
        </div>
        {gate && <HumanGatePanel avatarState={s.avatarState} captions={s.captions} meta={{ mode: p.persona.mode, characterId: p.character.id, providerId: s.providerId }} onIncident={s.captureIncident} incidentCount={s.incidentCount} optIn={s.incidentOptIn} onOptIn={s.setIncidentOptIn} />}
        {p.settings.captionsOn && <Captions items={s.captions} />}
        <SelfCamera enabled={p.settings.cameraOn} />
        <div className="controls" onClick={(e) => e.stopPropagation()}>
          <button type="button" className={`btn btn--icon ${s.muted ? "is-off" : "is-on"}`} onClick={s.toggleMute}>{s.muted ? "マイク切" : "マイク"}</button>
          <button type="button" className={`btn btn--icon ${p.settings.cameraOn ? "is-on" : ""}`} onClick={() => p.dispatch({ type: "camera", on: !p.settings.cameraOn })}>カメラ</button>
          <button type="button" className={`btn btn--icon ${p.settings.captionsOn ? "is-on" : ""}`} onClick={() => p.dispatch({ type: "captions", on: !p.settings.captionsOn })}>字幕</button>
          <button type="button" className="btn btn--danger" onClick={() => void s.end()} disabled={s.status === "ending" || s.status === "ended"}>
            {s.status === "ending" ? "評価中…" : "終了"}
          </button>
        </div>
      </div>
      <Toasts items={s.toasts} />
    </div>
  );
}
