import type { BrokerHealth } from "../api/health.js";
import type { CharacterEntry } from "../integrations/registry.js";

/** Renderer names as a person would say them (never shown in the conversation screen). */
export const RENDERER_JA: Record<CharacterEntry["renderer"], string> = {
  live2d: "アニメ 2D",
  vrm: "アニメ 3D",
  canvas: "デバッグ表示",
  liveavatar: "実写",
  tavus: "実写",
};

/** A character is represented by its own glyph — a name, not a fake portrait. */
export const PLATE: Record<string, string> = { yui: "結", haru: "春", reina: "玲", kei: "慧", heygen: "実", tavus: "実" };

/** UI wording for a BLOCKED_BY_* code; the code itself stays in the tooltip and the reports. */
export const BLOCKED_JA: Record<string, string> = {
  BLOCKED_BY_STRICT_LOCAL: "完全ローカル中は使えません",
  BLOCKED_BY_HEYGEN_KEY: "To be continued",
  BLOCKED_BY_TAVUS_KEY: "To be continued",
  NO_CHARACTER: "キャラクターがありません",
};

/** Realistic avatars sit beside the anime ones (spec §17), even before a key exists. */
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
