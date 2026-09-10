/**
 * Character pack registry (spec §9, §25). Model files live in `<id>/model/` and are fetched by
 * `scripts/fetch-sample-character.sh` (Live2D sample models, Free Material License) or supplied by the developer.
 */
export interface CharacterEntry {
  id: string;
  name: string;
  renderer: "live2d" | "vrm" | "human-glb" | "liveavatar" | "tavus" | "canvas";
  /** Served by the web app as a static directory (apps/web/public/characters → ../../characters). */
  baseUrl: string;
  license: string;
  defaultPersona: string;
  /** Short UI description. */
  description: string;
  /**
   * Other spellings the character answers to. Japanese speech recognition transcribes a romaji name
   * phonetically (「ゆい」, not "Yui"), so without these the character never hears itself being addressed
   * in a Japanese meeting and stays in OBSERVING forever.
   */
  aliases?: string[];
  /**
   * What speech recognition wrote when it misheard the name at an utterance onset, in real meetings.
   * Accepted only as 「〜、…？」 — an utterance-initial call followed by a question or request.
   */
  soundalikes?: string[];
}

export const characters: CharacterEntry[] = [
  {
    id: "yui",
    name: "Yui",
    aliases: ["ゆい", "ユイ", "結衣", "唯"], // 唯: run 79 heard 「唯イ寮の予定を教えて」 for 「ゆい、今日の予定を教えて」
    soundalikes: ["い", "うい", "つい", "ゆ"], // Gate #8 runs 10–13: 「い、今どう思う？」「うい、」「つい今どう思う？」
    renderer: "live2d",
    baseUrl: "/characters/yui",
    license: "Live2D sample 'Hiyori' — Live2D Free Material License (dev only)",
    defaultPersona: "friendly",
    description: "明るく親しみやすい。雑談・英会話向け。",
  },
  {
    id: "haru",
    name: "Haru",
    aliases: ["はる", "ハル", "春"],
    renderer: "live2d",
    baseUrl: "/characters/haru",
    license: "Live2D sample 'Haru' — Live2D Free Material License (dev only)",
    defaultPersona: "english_teacher",
    description: "落ち着いた先生タイプ。英語レッスン・家庭教師向け。",
  },
  {
    id: "kei",
    name: "Kei",
    aliases: ["けい", "ケイ", "圭"],
    renderer: "live2d",
    baseUrl: "/characters/kei",
    license: "Live2D sample 'Kei_basic' (MotionSync sample) — Live2D Free Material License (dev only)",
    defaultPersona: "friendly",
    description: "MotionSync 対応サンプル（motionsync3.json 同梱）。口パク A/B 用。",
  },
  {
    id: "reina",
    name: "Reina",
    aliases: ["れいな", "レイナ", "礼奈"],
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
