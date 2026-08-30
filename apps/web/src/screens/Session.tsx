import { useEffect, useMemo, useRef, useState } from "react";
import type { Persona } from "@rcai/persona-core";
import { Subtitle, TranscriptLog } from "../components/Subtitle.jsx";
import { LatencyHud } from "../components/LatencyHud.jsx";
import { SelfCamera } from "../components/SelfCamera.jsx";
import { SessionSheet } from "../components/SessionSheet.jsx";
import { Toasts } from "../components/Toasts.jsx";
import { HumanGatePanel } from "../components/HumanGatePanel.jsx";
import type { CharacterEntry } from "../integrations/registry.js";
import { pillFor } from "../session/pill.js";
import type { SessionOutcome } from "../session/SessionController.js";
import { useSession } from "../session/useSession.js";
import type { Availability, Settings, SettingsAction } from "../state/settings.js";
import { MODE_NAME } from "./Home.jsx";

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

const MicIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
const MicOffIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v6M15 15a3 3 0 0 1-6-2" /><path d="M5 11a7 7 0 0 0 11 5.5M19 11a7 7 0 0 1-.6 2.8M12 18v3" /><path d="M4 3l16 18" /></svg>
);
const CameraIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2.5" /><path d="M16 11l5-3v8l-5-3z" /></svg>
);
const EndIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 13.5c4-4 11-4 15 0l-2 2-3-1.5V11a11 11 0 0 0-5 0v3l-3 1.5z" /></svg>
);

/** Level 1 only. The avatar carries the state; everything else waits behind ···. */
export function Session(p: SessionProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const init = useMemo(
    () => ({ settings: p.settings, availability: p.availability, persona: p.persona, character: p.character, params: p.params }),
    // Session identity is fixed at mount; changes mid-session go through the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.persona.id, p.character.id],
  );
  const s = useSession(init, stageRef, p.onEnded);
  const [sheet, setSheet] = useState(false);
  const [gate, setGate] = useState(false);
  const pill = pillFor(s.avatarState, s.status === "starting");

  useEffect(() => {
    if (!sheet) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheet(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheet]);

  return (
    <div className="session">
      <div className="stage" onClick={() => (sheet ? setSheet(false) : s.interrupt())} role="button" aria-label="タップで割り込む">
        <div className="stage__mount" ref={stageRef} />

        {s.status === "starting" && <div className="stage__loading">支度中…</div>}
        {s.status === "error" && (
          <div className="stage__loading">
            <div style={{ textAlign: "center" }}>
              <p className="err" style={{ marginBottom: 18 }}>セッションを開始できませんでした。</p>
              <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); p.onAbort(); }}>戻る</button>
            </div>
          </div>
        )}

        <div className="session__head" onClick={(e) => e.stopPropagation()}>
          <span className="session__who">
            <b>{p.character.name}</b>
            <span className="session__mode">{MODE_NAME[p.persona.mode] ?? p.persona.mode}</span>
          </span>
          <button type="button" className={`more ${sheet ? "is-open" : ""}`} aria-label="セッション設定" aria-expanded={sheet} onClick={() => setSheet((v) => !v)}>···</button>
        </div>

        {/* The state whisper fades after a glance; the character does the talking. */}
        <div key={`${pill.key}-${s.captions.length}`} className={`pill pill--${pill.key}`}>
          <span className="pill__dot" />
          {pill.en}
          <span className="pill__ja">{pill.ja}</span>
        </div>

        <Subtitle items={s.captions} on={p.settings.captionsOn} />
        <TranscriptLog items={s.captions} />
        <SelfCamera enabled={p.settings.cameraOn} />
        {p.settings.showHud && <LatencyHud report={s.latency} providerId={s.providerId} observability={s.observability} />}

        {sheet && (
          <div onClick={(e) => e.stopPropagation()}>
            <SessionSheet
              settings={p.settings}
              dispatch={p.dispatch}
              availability={p.availability}
              characterName={p.character.name}
              providerId={s.providerId}
              live={s.status === "live"}
              gateOn={gate}
              onGate={setGate}
              onProvider={(id) => void s.switchProvider(id)}
              onClose={() => setSheet(false)}
            />
          </div>
        )}
        {gate && !sheet && (
          <div onClick={(e) => e.stopPropagation()}>
            <HumanGatePanel
              avatarState={s.avatarState}
              captions={s.captions}
              meta={{ mode: p.persona.mode, characterId: p.character.id, providerId: s.providerId }}
              onIncident={s.captureIncident}
              incidentCount={s.incidentCount}
              optIn={s.incidentOptIn}
              onOptIn={s.setIncidentOptIn}
            />
          </div>
        )}

        <div className="controls" onClick={(e) => e.stopPropagation()}>
          <button type="button" className={`ctl ${s.muted ? "is-off" : ""}`} onClick={s.toggleMute} aria-pressed={!s.muted}>
            <span className="ctl__ring">{s.muted ? <MicOffIcon /> : <MicIcon />}</span>
            <span className="ctl__label">{s.muted ? "ミュート中" : "マイク"}</span>
          </button>
          <button type="button" className={`ctl ${p.settings.cameraOn ? "is-active" : ""}`} onClick={() => p.dispatch({ type: "camera", on: !p.settings.cameraOn })} aria-pressed={p.settings.cameraOn}>
            <span className="ctl__ring"><CameraIcon /></span>
            <span className="ctl__label">カメラ</span>
          </button>
          <button type="button" className="ctl ctl--end" onClick={() => void s.end()} disabled={s.status === "ending" || s.status === "ended"}>
            <span className="ctl__ring"><EndIcon /></span>
            <span className="ctl__label">{s.status === "ending" ? "評価中…" : "終了"}</span>
          </button>
        </div>
      </div>
      <Toasts items={s.toasts} />
    </div>
  );
}
