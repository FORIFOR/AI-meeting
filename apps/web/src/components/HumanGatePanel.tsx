import { useEffect, useState } from "react";
import type { AvatarState } from "@rcai/avatar-core";
import { GATE_TAGS, loadGate, saveGate, type GateEntry } from "./humanGateStore.js";

export interface HumanGatePanelProps {
  avatarState: AvatarState;
  captions: { role: string; text: string }[];
  meta: { mode: string; characterId: string; providerId: string | null };
  /** Round 3 Gate 6: capture ±5 s of presence context as one incident. */
  onIncident?: (note?: string) => void;
  incidentCount?: number;
  optIn?: { audio: boolean; video: boolean };
  onOptIn?: (next: { audio?: boolean; video?: boolean }) => void;
}

/** One-tap observation logger for the 10-minute Human Reality Gate (docs/human-gate.md). */
export function HumanGatePanel(p: HumanGatePanelProps) {
  const [entries, setEntries] = useState<GateEntry[]>(() => loadGate());
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => saveGate(entries), [entries]);
  const log = (tag: string) => {
    const e: GateEntry = {
      at: Date.now(), kind: "observation", tag, avatarState: p.avatarState,
      captions: p.captions.slice(-2).map((c) => `${c.role === "user" ? "You" : "AI"}: ${c.text}`),
      mode: p.meta.mode, characterId: p.meta.characterId, providerId: p.meta.providerId ?? undefined,
    };
    setEntries((x) => [...x, e]);
    setFlash(tag);
    setTimeout(() => setFlash(null), 700);
  };
  const count = entries.filter((e) => e.kind === "observation").length;
  const [incidentFlash, setIncidentFlash] = useState(false);
  const incident = () => {
    p.onIncident?.();
    setEntries((x) => [...x, { at: Date.now(), kind: "note", tag: "不自然だった瞬間", note: "incident", avatarState: p.avatarState, mode: p.meta.mode, characterId: p.meta.characterId, providerId: p.meta.providerId ?? undefined }]);
    setIncidentFlash(true);
    setTimeout(() => setIncidentFlash(false), 900);
  };
  const optIn = p.optIn ?? { audio: false, video: false };
  return (
    <div className="gate" onClick={(e) => e.stopPropagation()}>
      <div className="gate__head">
        <span>HUMAN GATE · {p.avatarState}</span>
        <span className="menu__meta">{count} logged · {p.incidentCount ?? 0} incidents</span>
      </div>
      {p.onIncident && (
        <button type="button" className={`gate__incident ${incidentFlash ? "is-flash" : ""}`} onClick={incident} title="押した時刻の前後5秒の文脈（字幕・イベント・Avatar状態・motion・感情・視線・VAD・遅延）を1件として保存">
          不自然だった瞬間 <small>±5 s を記録</small>
        </button>
      )}
      {p.onOptIn && (
        <label className="gate__optin">
          <input type="checkbox" checked={optIn.audio} onChange={(e) => p.onOptIn?.({ audio: e.target.checked, video: e.target.checked })} />
          <span>音声/映像を保存する <small>既定 OFF · 本人の明示同意時のみ（マイク・AI音声 各5秒、カメラ静止画）</small></span>
        </label>
      )}
      <div className="gate__grid">
        {GATE_TAGS.map((t) => (
          <button key={t} type="button" className={`gate__btn ${t.startsWith("👍") ? "gate__btn--good" : ""} ${flash === t ? "is-flash" : ""}`} onClick={() => log(t)}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}
