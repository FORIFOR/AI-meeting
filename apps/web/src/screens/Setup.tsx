import { useMemo, useState } from "react";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import { EngineSelector } from "../components/EngineSelector.jsx";
import type { CharacterEntry } from "../integrations/registry.js";
import type { Availability, Settings, SettingsAction } from "../state/settings.js";
import { PRODUCTS } from "./Home.jsx";

export interface SetupProps {
  mode: ConversationMode;
  personas: Persona[];
  characters: CharacterEntry[];
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  availability: Availability | null;
  onBack: () => void;
  onStart: (persona: Persona, params: Record<string, string>) => void;
}

/** Spec §19 (Interview) / §20 (English modes) start screen, driven by persona.params. */
export function Setup(p: SetupProps) {
  const product = PRODUCTS.find((x) => x.mode === p.mode)!;
  const [personaId, setPersonaId] = useState(p.personas[0]?.id ?? "");
  const persona = p.personas.find((x) => x.id === personaId) ?? p.personas[0];
  const [params, setParams] = useState<Record<string, string>>({});
  const values = useMemo(() => {
    const v: Record<string, string> = {};
    for (const spec of persona?.params ?? []) v[spec.key] = params[spec.key] ?? spec.default ?? spec.options?.[0] ?? "";
    return v;
  }, [persona, params]);
  if (!persona) return <div className="setup"><div className="card"><p className="empty">このモードのペルソナがありません。</p><button className="btn" onClick={p.onBack}>戻る</button></div></div>;
  const charLabel = p.mode === "interview" ? "面接官 · Interviewer" : "キャラクター · Character";
  return (
    <div className="setup">
      <div className="card">
        <div className="card__eyebrow">{product.kana}</div>
        <h2 className="card__title">{product.name}</h2>
        <div className="card__grid">
          {p.personas.length > 1 && (
            <div className="field">
              <label>{p.mode === "english_lesson" ? "Mode" : "Persona"}</label>
              <div className="chips">
                {p.personas.map((x) => (
                  <button key={x.id} type="button" className={`chip ${x.id === persona.id ? "is-active" : ""}`} onClick={() => setPersonaId(x.id)}>
                    {x.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          {(persona.params ?? []).map((spec) => (
            <div className="field" key={spec.key}>
              <label>{spec.label}</label>
              {spec.type === "select" ? (
                <select className="select" value={values[spec.key]} onChange={(e) => setParams({ ...params, [spec.key]: e.target.value })}>
                  {(spec.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input className="input" value={values[spec.key]} onChange={(e) => setParams({ ...params, [spec.key]: e.target.value })} />
              )}
            </div>
          ))}
          <div className="field">
            <label>{charLabel}</label>
            <select className="select" value={p.settings.characterId || p.characters[0]?.id} onChange={(e) => p.dispatch({ type: "character", id: e.target.value })}>
              {p.characters.map((c) => {
                const cloud = c.renderer === "liveavatar" || c.renderer === "tavus";
                const blocked = p.settings.privacyMode === "strict_local" && cloud;
                return (
                  <option key={c.id} value={c.id} disabled={blocked}>{c.name} — {c.renderer}{blocked ? " (BLOCKED_BY_STRICT_LOCAL)" : ""}</option>
                );
              })}
            </select>
          </div>
          <div className="field">
            <label>AI Engine</label>
            <EngineSelector settings={p.settings} dispatch={p.dispatch} availability={p.availability} />
          </div>
        </div>
        <div className="card__actions">
          <button type="button" className="btn btn--ghost" onClick={p.onBack}>← 戻る</button>
          <button type="button" className="btn btn--primary btn--lg" onClick={() => p.onStart(persona, values)}>
            {p.mode === "interview" ? "Start Interview" : p.mode === "english_lesson" ? "Start Lesson" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
