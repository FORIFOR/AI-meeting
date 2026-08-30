import type { ProviderId } from "@rcai/conversation-core";
import type { AutoPolicy, EngineSelection, Role } from "@rcai/provider-core";
import { POLICY_LABEL, PROVIDER_LABEL, ROLE_LABEL, decide, type Availability, type Settings, type SettingsAction } from "../state/settings.js";

const ENGINES: { id: EngineSelection; ja: string; en: string }[] = [
  { id: "auto", ja: "自動で選ぶ", en: "" },
  { id: "openai", ja: "OpenAI", en: "Realtime" },
  { id: "google", ja: "Google Gemini", en: "Live" },
  { id: "local", ja: "ローカル", en: "" },
];
const ROLES: Role[] = ["conversation", "vision", "transcription", "evaluation"];
const PROVIDERS: ProviderId[] = ["openai", "google", "local"];

function availLabel(id: EngineSelection, a: Availability | null): { text: string; ok: boolean | null } {
  if (!a || id === "auto") return { text: "", ok: null };
  const ok = id === "openai" ? a.openai : id === "google" ? a.google : a.local;
  return { text: ok ? "ready" : id === "local" ? "agent offline" : "no key", ok };
}

/** Spec §7 AI Engine selector with Auto policy and the Advanced per-role table. */
export function EngineSelector({ settings, dispatch, availability }: { settings: Settings; dispatch: (a: SettingsAction) => void; availability: Availability | null }) {
  const strict = settings.privacyMode === "strict_local";
  const decision = decide(settings, availability ?? undefined);
  return (
    <div className="engine">
      {ENGINES.map((e) => {
        const disabled = strict && e.id !== "local";
        const a = availLabel(e.id, availability);
        return (
          <label key={e.id} className={`radio ${settings.engine === e.id ? "is-active" : ""} ${disabled ? "is-disabled" : ""}`}>
            <input type="radio" name="engine" hidden checked={settings.engine === e.id} disabled={disabled} onChange={() => dispatch({ type: "engine", engine: e.id })} />
            <span className="radio__dot" />
            <span className="radio__label">
              {e.ja}{e.en && <span className="radio__meta"> {e.en}</span>}
            </span>
            {a.text && <span className={`radio__meta ${a.ok ? "is-ok" : "is-bad"}`}>{a.text}</span>}
          </label>
        );
      })}
      {settings.engine === "auto" && (
        <div className="field">
          <label>選び方</label>
          <select className="select" value={settings.autoPolicy} onChange={(ev) => dispatch({ type: "autoPolicy", policy: ev.target.value as AutoPolicy })}>
            {(Object.keys(POLICY_LABEL) as AutoPolicy[]).map((p) => (
              <option key={p} value={p} disabled={strict && p !== "offline" && p !== "privacy_first"}>
                {POLICY_LABEL[p].ja}
              </option>
            ))}
          </select>
        </div>
      )}
      <details className="advanced">
        <summary>役割ごとに指定する</summary>
        <table>
          <tbody>
            {ROLES.map((role) => (
              <tr key={role}>
                <td>
                  {ROLE_LABEL[role].ja}
                </td>
                <td>
                  <select
                    className="select"
                    value={settings.advanced[role] ?? ""}
                    onChange={(ev) => dispatch({ type: "advanced", role, provider: (ev.target.value || undefined) as ProviderId | undefined })}
                  >
                    <option value="">自動 — {PROVIDER_LABEL[decision[role]]}</option>
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p} disabled={strict && p !== "local"}>
                        {PROVIDER_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
