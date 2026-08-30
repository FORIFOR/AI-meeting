import type { AvatarParams, Emotion } from "./types.js";

/** Canonical expression targets (spec §9 expressions/*.exp3.json equivalents). */
export const DEFAULT_EXPRESSIONS: Record<Emotion, Partial<AvatarParams>> = {
  neutral: {},
  smile: { eyeLSmile: 0.8, eyeRSmile: 0.8, mouthForm: 0.7, cheek: 0.5, browLY: 0.1, browRY: 0.1 },
  laugh: { eyeLSmile: 1, eyeRSmile: 1, eyeLOpen: 0.4, eyeROpen: 0.4, mouthForm: 1, cheek: 0.8, angleY: -3 },
  serious: { browLY: -0.35, browRY: -0.35, browLForm: -0.4, browRForm: -0.4, mouthForm: -0.2, eyeLOpen: 0.9, eyeROpen: 0.9 },
  sad: { browLForm: 0.6, browRForm: 0.6, browLY: -0.15, browRY: -0.15, mouthForm: -0.6, eyeLOpen: 0.75, eyeROpen: 0.75, angleY: -4 },
  thinking: { browLY: 0.25, browRY: 0.05, eyeBallX: 0.45, eyeBallY: 0.45, angleZ: 5, mouthForm: -0.1 },
  surprised: { eyeLOpen: 1.3, eyeROpen: 1.3, browLY: 0.8, browRY: 0.8, mouthForm: -0.2, angleY: 3 },
  warm_positive: { eyeLSmile: 0.45, eyeRSmile: 0.45, mouthForm: 0.4, cheek: 0.25, browLY: 0.1, browRY: 0.1 },
  concerned: { browLForm: 0.4, browRForm: 0.4, browLY: -0.1, browRY: -0.1, mouthForm: -0.35, angleZ: -3 },
  encourage: { eyeLSmile: 0.5, eyeRSmile: 0.5, mouthForm: 0.5, browLY: 0.2, browRY: 0.2, angleY: -2 },
};

/** Parse a Live2D exp3.json into canonical params where ids are standard. */
export function expressionFromExp3(exp3: { Parameters?: { Id: string; Value: number; Blend?: string }[] }, idMap: Record<string, keyof AvatarParams>): Partial<AvatarParams> {
  const out: Partial<AvatarParams> = {};
  for (const p of exp3.Parameters ?? []) {
    const key = idMap[p.Id];
    if (key) out[key] = p.Value;
  }
  return out;
}
