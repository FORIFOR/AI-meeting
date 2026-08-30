import type { BrokerHealth } from "../api/health.js";
import type { CharacterEntry } from "../integrations/registry.js";

export const RENDERER_JA: Record<CharacterEntry["renderer"], string> = {
  live2d: "アニメ 2D",
  vrm: "アニメ 3D",
  canvas: "デバッグ表示",
  liveavatar: "実写",
  tavus: "実写",
};

const RENDERER_LABEL: Record<CharacterEntry["renderer"], string> = {
  live2d: "2D",
  vrm: "3D",
  canvas: "debug",
  liveavatar: "実写",
  tavus: "実写",
};

/** The plate shows the character's own first glyph — a name plate, not a portrait. */
const PLATE: Record<string, string> = { yui: "結", haru: "春", reina: "玲", kei: "慧", heygen: "実", tavus: "実" };

/** Virtual realistic entries so Realistic / Anime 2D / Anime 3D sit side by side (spec §17). */
export function withRealistic(entries: CharacterEntry[]): CharacterEntry[] {
  const out = [...entries];
  if (!out.some((e) => e.renderer === "liveavatar")) out.push({ id: "heygen", name: "HeyGen LiveAvatar", renderer: "liveavatar", baseUrl: "/characters/heygen", license: "HeyGen cloud" });
  if (!out.some((e) => e.renderer === "tavus")) out.push({ id: "tavus", name: "Tavus", renderer: "tavus", baseUrl: "/characters/tavus", license: "Tavus cloud" });
  return out;
}

/** UI wording for a BLOCKED_BY_* code; the code itself stays in the tooltip. */
export const BLOCKED_JA: Record<string, string> = {
  BLOCKED_BY_STRICT_LOCAL: "完全ローカル中は使えません",
  BLOCKED_BY_HEYGEN_KEY: "APIキーが未設定",
  BLOCKED_BY_TAVUS_KEY: "APIキーが未設定",
  NO_CHARACTER: "キャラクターがありません",
};

export function blockedReason(e: CharacterEntry, broker: BrokerHealth | null, strict: boolean): string | null {
  if (e.renderer === "liveavatar") return strict ? "BLOCKED_BY_STRICT_LOCAL" : broker?.providers.heygen ? null : "BLOCKED_BY_HEYGEN_KEY";
  if (e.renderer === "tavus") return strict ? "BLOCKED_BY_STRICT_LOCAL" : broker?.providers.tavus ? null : "BLOCKED_BY_TAVUS_KEY";
  return null;
}

export function CharacterPicker({ entries, selected, onSelect, broker, strict }: { entries: CharacterEntry[]; selected: string; onSelect: (id: string) => void; broker: BrokerHealth | null; strict: boolean }) {
  return (
    <div className="chars">
      {entries.map((e) => {
        const blocked = blockedReason(e, broker, strict);
        return (
          <button key={e.id} type="button" className={`char ${selected === e.id ? "is-active" : ""} ${blocked ? "is-blocked" : ""}`} onClick={() => onSelect(e.id)} title={blocked ? `${blocked} — ${e.license ?? ""}` : e.license ?? ""}>
            <div className={`char__avatar ${e.renderer === "vrm" ? "char__avatar--3d" : e.renderer === "liveavatar" || e.renderer === "tavus" ? "char__avatar--real" : ""}`} aria-hidden="true">
              {PLATE[e.id] ?? e.name.slice(0, 1)}
            </div>
            <div className="char__badge">{RENDERER_LABEL[e.renderer]}</div>
            <div className="char__name">{e.name}</div>
            {e.license && <div className="char__lic">{e.license}</div>}
            {blocked && <div className="char__blocked">{BLOCKED_JA[blocked] ?? blocked}</div>}
          </button>
        );
      })}
    </div>
  );
}
