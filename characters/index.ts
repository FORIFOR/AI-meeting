/**
 * Character pack registry (spec §9, §25). Model files live in `<id>/model/` and are fetched by
 * `scripts/fetch-sample-character.sh` (Live2D sample models, Free Material License) or supplied by the developer.
 */
export interface CharacterEntry {
  id: string;
  name: string;
  renderer: "live2d" | "vrm" | "liveavatar" | "tavus" | "canvas";
  /** Served by the web app as a static directory (apps/web/public/characters → ../../characters). */
  baseUrl: string;
  license: string;
  defaultPersona: string;
  /** Short UI description. */
  description: string;
}

export const characters: CharacterEntry[] = [
  {
    id: "yui",
    name: "Yui",
    renderer: "live2d",
    baseUrl: "/characters/yui",
    license: "Live2D sample 'Hiyori' — Live2D Free Material License (dev only)",
    defaultPersona: "friendly",
    description: "明るく親しみやすい。雑談・英会話向け。",
  },
  {
    id: "haru",
    name: "Haru",
    renderer: "live2d",
    baseUrl: "/characters/haru",
    license: "Live2D sample 'Haru' — Live2D Free Material License (dev only)",
    defaultPersona: "english_teacher",
    description: "落ち着いた先生タイプ。英語レッスン・家庭教師向け。",
  },
  {
    id: "kei",
    name: "Kei",
    renderer: "live2d",
    baseUrl: "/characters/kei",
    license: "Live2D sample 'Kei_basic' (MotionSync sample) — Live2D Free Material License (dev only)",
    defaultPersona: "friendly",
    description: "MotionSync 対応サンプル（motionsync3.json 同梱）。口パク A/B 用。",
  },
  {
    id: "reina",
    name: "Reina",
    renderer: "live2d",
    baseUrl: "/characters/reina",
    license: "Live2D sample 'Mao' — Live2D Free Material License (dev only)",
    defaultPersona: "interviewer",
    description: "冷静でフォーマル。面接官・キャリア相談向け。",
  },
];

export function getCharacter(id: string): CharacterEntry | undefined {
  return characters.find((c) => c.id === id);
}
