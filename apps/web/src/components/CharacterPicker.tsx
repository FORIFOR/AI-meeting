import type { BrokerHealth } from "../api/health.js";
import type { CharacterEntry } from "../integrations/registry.js";

const RENDERER_LABEL: Record<CharacterEntry["renderer"], string> = {
  live2d: "Anime 2D",
  vrm: "Anime 3D",
  canvas: "Debug 2D",
  liveavatar: "Realistic",
  tavus: "Realistic",
};

/** Virtual realistic entries so Realistic / Anime 2D / Anime 3D sit side by side (spec §17). */
export function withRealistic(entries: CharacterEntry[]): CharacterEntry[] {
  const out = [...entries];
  if (!out.some((e) => e.renderer === "liveavatar")) out.push({ id: "heygen", name: "HeyGen LiveAvatar", renderer: "liveavatar", baseUrl: "/characters/heygen", license: "HeyGen cloud" });
  if (!out.some((e) => e.renderer === "tavus")) out.push({ id: "tavus", name: "Tavus", renderer: "tavus", baseUrl: "/characters/tavus", license: "Tavus cloud" });
  return out;
}

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
          <button key={e.id} type="button" className={`char ${selected === e.id ? "is-active" : ""} ${blocked ? "is-blocked" : ""}`} onClick={() => onSelect(e.id)} title={e.license ?? ""}>
            <div className={`char__avatar ${e.renderer === "vrm" ? "char__avatar--3d" : e.renderer === "liveavatar" || e.renderer === "tavus" ? "char__avatar--real" : ""}`} />
            <div className="char__badge">{RENDERER_LABEL[e.renderer]}</div>
            <div className="char__name">{e.name}</div>
            {e.license && <div className="char__lic">{e.license}</div>}
            {blocked && <div className="char__blocked">{blocked}</div>}
          </button>
        );
      })}
    </div>
  );
}
