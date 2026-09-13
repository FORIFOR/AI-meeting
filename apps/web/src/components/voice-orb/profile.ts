import type { VoiceOrbState } from "../../session/voiceActivity.js";
import { referencePreset, type OrbParams } from "./vendor/presets.js";

/** The linked preset is the thinking state; quiet and audio states share its glass. */
export function orbProfile(state: VoiceOrbState, energy: number): OrbParams {
  const p = { ...referencePreset };
  const level = Number.isFinite(energy) ? Math.max(0, Math.min(1, energy)) : 0;
  if (state === "thinking") return p;
  if (state === "listening") return {
    ...p, speed: 0.38 + level * 0.45, zoom: 0.34 + level * 0.045,
    warp: 1.8 + level * 1.8, ridgeAmt: 0.28 + level * 0.25,
    exposure: 1.6 + level * 0.4, colorA: "#B4F4EE", colorC: "#A2B6FF",
  };
  if (state === "speaking") return {
    ...p, speed: 0.65 + level * 0.65, zoom: 0.35 + level * 0.055,
    warp: 2.4 + level * 1.8, ridgeAmt: 0.38 + level * 0.3,
    exposure: 1.8 + level * 0.2,
  };
  return {
    ...p, speed: state === "muted" || state === "error" || state === "ending" || state === "ended" ? 0 : 0.246,
    zoom: 0.3384, warp: 1.664, ridgeAmt: 0.24, sharp: 1.98, exposure: 1.36,
    colorA: "#B5A674", colorB: "#5E8794", colorC: "#9A648A", colorD: "#635B8A",
    highlightColor: "#B6C4D2", glowColor: "#6C688F",
  };
}
