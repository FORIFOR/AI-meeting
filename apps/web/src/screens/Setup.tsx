import { useMemo, useState } from "react";
import type { ConversationMode } from "@rcai/conversation-core";
import type { Persona } from "@rcai/persona-core";
import type { CharacterEntry } from "../integrations/registry.js";
import { VOICE_OPTIONS, localVoiceOptions } from "@rcai/persona-core";
import { chosenVoice, decide, type Settings, type SettingsAction } from "../state/settings.js";
import { PRODUCTS } from "./Home.jsx";

export interface SetupProps {
  mode: ConversationMode;
  personas: Persona[];
  characters: CharacterEntry[];
  settings: Settings;
  dispatch: (a: SettingsAction) => void;
  /** Local voices depend on the machine; the agent reports the ones actually installed. */
  agent?: { tts?: { voices?: string[] } } | null;
  onBack: () => void;
  onCharacter: () => void;
  onStart: (persona: Persona, params: Record<string, string>) => void;
}

/** Only what the session needs. Engines and endpoints live in Settings. */
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
  const character = p.characters.find((c) => c.id === p.settings.characterId) ?? p.characters[0];
  // The voice belongs next to "who am I talking to", not buried in settings — it is chosen at the same moment.
  const providerId = decide(p.settings).conversation;
  const voiceOptions = providerId === "local" ? localVoiceOptions(p.agent?.tts?.voices) : VOICE_OPTIONS[providerId];

  if (!persona) {
    return (
      <div className="page">
        <p className="empty">このモードのペルソナがありません。</p>
        <button type="button" className="btn" onClick={p.onBack}>戻る</button>
      </div>
    );
  }

  const partnerLabel = p.mode === "interview" ? "面接官" : "相手";
  const styleLabel = p.mode === "english_lesson" ? "レッスン" : "進め方";

  return (
    <div className="page">
      <p className="page__eyebrow">{product.kana}</p>
      <h1 className="page__title">{product.name}</h1>
      <p className="page__lede">{product.desc}</p>

      <div className="rows">
        {p.personas.length > 1 && (
          <div className="row">
            <span className="row__label">{styleLabel}</span>
            <span className="row__value">
              <span className="chips">
                {p.personas.map((x) => (
                  <button key={x.id} type="button" className={`chip ${x.id === persona.id ? "is-active" : ""}`} onClick={() => setPersonaId(x.id)}>
                    {x.name}
                  </button>
                ))}
              </span>
            </span>
          </div>
        )}
        {(persona.params ?? []).map((spec) => (
          <div className="row" key={spec.key}>
            <span className="row__label">{spec.label}</span>
            <span className="row__value">
              {spec.type === "select" ? (
                <select className="select" value={values[spec.key]} onChange={(e) => setParams({ ...params, [spec.key]: e.target.value })}>
                  {(spec.options ?? []).map((o) => (
                    <option key={o} value={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input className="input" value={values[spec.key]} onChange={(e) => setParams({ ...params, [spec.key]: e.target.value })} />
              )}
            </span>
          </div>
        ))}
        <button type="button" className="row" onClick={p.onCharacter}>
          <span className="row__label">{partnerLabel}</span>
          <span className="row__value">{character?.name ?? "—"} <span className="row__chev">›</span></span>
        </button>
        <div className="row">
          <span className="row__label">声</span>
          <span className="row__value">
            <select
              className="select"
              value={chosenVoice(p.settings, character?.id, providerId) ?? ""}
              onChange={(e) => character && p.dispatch({ type: "voice", characterId: character.id, providerId, voiceId: e.target.value || undefined })}
              disabled={!character}
            >
              <option value="">{character?.name ?? "この相手"}の声</option>
              {voiceOptions.map((v) => (
                <option key={v.id} value={v.id}>{v.label} — {v.note}</option>
              ))}
            </select>
          </span>
        </div>
      </div>

      <div className="page__actions">
        <button type="button" className="btn btn--ghost" onClick={p.onBack}>戻る</button>
        <button type="button" className="btn btn--primary btn--lg" onClick={() => p.onStart(persona, values)}>
          はじめる
        </button>
      </div>
    </div>
  );
}
