// Adapted from LerSent001/orb (MIT), commit 047c58cc93587c21dac12183fc0fb1e4101c8e1a. See LICENSE.
export type StyleName = "siri";

export type OrbParams = {
  style: StyleName;
  glassEnabled: boolean;
  speed: number;
  radius: number;
  contourDeform: number;
  bandDensity: number;
  chromaticShift: number;
  metalScale: number;
  metalStretch: number;
  metalAngle: number;
  metalOffset: number;
  metalPhase: number;
  metalEvolution: number;
  metalRoughness: number;
  metalDepth: number;
  particleDensity: number;
  ribbonCount: number;
  ribbonWidth: number;
  ribbonTwist: number;
  ribbonFold: number;
  ribbonBreath: number;
  particleSize: number;
  particleBloom: number;
  zoom: number;
  warp: number;
  ridgeAmt: number;
  sharp: number;
  shade: number;
  sheen: number;
  gloss: number;
  glassOpacity: number;
  shellMidAlpha: number;
  shellEdgeAlpha: number;
  exposure: number;
  edgeSoftness: number;
  edgeGlow: number;
  colorA: string;
  colorB: string;
  colorC: string;
  colorD: string;
  highlightColor: string;
  shellInner: string;
  shellMid: string;
  shellEdge: string;
  sheenColor: string;
  specColor: string;
  canvasColor: string;
  glowColor: string;
};

const basePreset: Omit<OrbParams, "style"> = {
  glassEnabled: true,
  speed: 1,
  radius: 0.72,
  contourDeform: 0,
  bandDensity: 2,
  chromaticShift: 0.42,
  metalScale: 0.77,
  metalStretch: 0.23,
  metalAngle: 65,
  metalOffset: 0,
  metalPhase: 0,
  metalEvolution: 1,
  metalRoughness: 0.22,
  metalDepth: 0.25,
  particleDensity: 0.72,
  ribbonCount: 5,
  ribbonWidth: 0.42,
  ribbonTwist: 1.25,
  ribbonFold: 0.55,
  ribbonBreath: 0.3,
  particleSize: 1.2,
  particleBloom: 0.7,
  zoom: 0.3,
  warp: 3,
  ridgeAmt: 0.5,
  sharp: 2.2,
  shade: 0.3,
  sheen: 0.36,
  gloss: 0.28,
  glassOpacity: 0.42,
  shellMidAlpha: 0.2,
  shellEdgeAlpha: 0.22,
  exposure: 1,
  edgeSoftness: 0.005,
  edgeGlow: 0,
  colorA: "#F7FBFF",
  colorB: "#D6E8F7",
  colorC: "#A8C8F0",
  colorD: "#6F9EE8",
  highlightColor: "#FFFFFF",
  shellInner: "#FFFFFF",
  shellMid: "#D6E8F7",
  shellEdge: "#6F9EE8",
  sheenColor: "#EAF4FF",
  specColor: "#DCEAFF",
  canvasColor: "#000000",
  glowColor: "#6F9EE8",
};

export const referencePreset: OrbParams = {
  style: "siri",
    ...basePreset,
    speed: 0.82,
    zoom: 0.36,
    warp: 3.2,
    ridgeAmt: 0.5,
    sharp: 2.2,
    shade: 0.12,
    sheen: 0.28,
    gloss: 0.24,
    glassOpacity: 0.44,
    shellMidAlpha: 0.18,
    shellEdgeAlpha: 0.18,
    exposure: 2,
    colorA: "#FFD86B",
    colorB: "#82F4FF",
    colorC: "#FF7BD5",
    colorD: "#8E6CFF",
    shellMid: "#9BF4FF",
    shellEdge: "#C5A9FF",
    canvasColor: "#030409",
    glowColor: "#956CFF",
};
export const styleFlowIndexes = { siri: 9 };
