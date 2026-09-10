import type { CharacterDefinition, CharacterManifest, MotionCategory, VoiceProfile } from "./types.js";

export class CharacterValidationError extends Error {}

const RENDERERS = new Set(["live2d", "vrm", "human-glb", "liveavatar", "tavus", "canvas"]);
const CATEGORIES: MotionCategory[] = ["idle", "listening", "speaking", "thinking", "reaction", "social", "teaching", "greeting"];

export function validateManifest(raw: unknown): CharacterManifest {
  const m = raw as Partial<CharacterManifest>;
  if (!m || typeof m !== "object") throw new CharacterValidationError("manifest must be an object");
  for (const k of ["id", "name", "renderer", "defaultPersona", "motionProfile"] as const) {
    if (typeof m[k] !== "string" || !m[k]) throw new CharacterValidationError(`manifest.${k} required`);
  }
  if (!RENDERERS.has(m.renderer!)) throw new CharacterValidationError(`unknown renderer ${m.renderer}`);
  if (!Array.isArray(m.supportedLanguages) || m.supportedLanguages.length === 0) throw new CharacterValidationError("manifest.supportedLanguages required");
  if (!Array.isArray(m.voiceProfiles)) throw new CharacterValidationError("manifest.voiceProfiles required");
  return m as CharacterManifest;
}

export interface CharacterJson {
  model: string;
  expressions?: CharacterDefinition["expressions"];
  motions?: Partial<Record<MotionCategory, string[]>>;
  motionFiles?: string[];
  voice: VoiceProfile;
  view?: CharacterDefinition["view"];
  paramIds?: CharacterDefinition["paramIds"];
}

export function buildCharacterDefinition(manifest: unknown, characterJson: unknown, baseUrl: string): CharacterDefinition {
  const m = validateManifest(manifest);
  const c = characterJson as Partial<CharacterJson>;
  if (!c || typeof c.model !== "string") throw new CharacterValidationError("character.json: model required");
  if (!c.voice || typeof c.voice !== "object") throw new CharacterValidationError("character.json: voice required");
  const motions = c.motions ?? {};
  for (const k of Object.keys(motions)) {
    if (!CATEGORIES.includes(k as MotionCategory)) throw new CharacterValidationError(`unknown motion category ${k}`);
  }
  return {
    manifest: m,
    baseUrl: baseUrl.replace(/\/$/, ""),
    model: c.model,
    expressions: c.expressions ?? {},
    motions,
    motionFiles: c.motionFiles,
    voice: { ...c.voice, characterId: m.id },
    view: c.view,
    paramIds: c.paramIds,
  };
}

/** Spec §24: same character, provider-specific voice id. */
export function resolveVoice(def: CharacterDefinition, providerId: "openai" | "google" | "local"): string | undefined {
  return def.voice.voices[providerId];
}

/** Fetch-based loader for browsers / node18+. */
export async function loadCharacter(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<CharacterDefinition> {
  const base = baseUrl.replace(/\/$/, "");
  const [manifest, character] = await Promise.all([
    fetchImpl(`${base}/manifest.json`).then((r) => {
      if (!r.ok) throw new CharacterValidationError(`manifest.json ${r.status}`);
      return r.json();
    }),
    fetchImpl(`${base}/character.json`).then((r) => {
      if (!r.ok) throw new CharacterValidationError(`character.json ${r.status}`);
      return r.json();
    }),
  ]);
  return buildCharacterDefinition(manifest, character, base);
}
