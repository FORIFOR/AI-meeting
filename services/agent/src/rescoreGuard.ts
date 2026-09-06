/**
 * Whisper on a sub-two-second clip does not so much mis-hear as make something up: across the real
 * rooms the second pass turned 「見たよ。」 into 「メタリオ」 three runs running, 「あ？」 into
 * 「ご視聴ありがとうございました」, 「Okay.」 into 「はい」. Those readings then sat in the
 * recent-utterance context and the character answered to a person who was never there
 * (run 84: 「メタリオさんが直前に話されていた…」). The streaming recogniser's short reading may be
 * rough, but it is at least what was heard, so a second pass that disagrees with it wholesale on a
 * short clip is dropped, and the stock hallucinations are dropped at any length.
 */

const SHORT_CLIP_S = 2.0;
const MIN_OVERLAP = 0.5;

/** Whole-text readings whisper produces for near-silence; a real one reads the same in the first pass. */
const STOCK_HALLUCINATIONS = new Set([
  "ご視聴ありがとうございました",
  "ありがとうございました",
  "おやすみなさい",
  "チャンネル登録お願いします",
  "字幕",
]);

function normalize(text: string): string {
  return text
    .replace(/[ァ-ヶ]/g, (k) => String.fromCharCode(k.charCodeAt(0) - 0x60)) // katakana → hiragana
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

function bigrams(s: string): string[] {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Dice coefficient over character bigrams of the normalized texts; 1 when they read the same. */
export function readingOverlap(a: string, b: string): number {
  const x = bigrams(normalize(a));
  const y = bigrams(normalize(b));
  if (!x.length && !y.length) return 1;
  if (!x.length || !y.length) return 0;
  const pool = new Map<string, number>();
  for (const g of x) pool.set(g, (pool.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of y) {
    const n = pool.get(g) ?? 0;
    if (n > 0) { shared++; pool.set(g, n - 1); }
  }
  return (2 * shared) / (x.length + y.length);
}

/**
 * Why the second reading should be thrown away, or undefined to accept it.
 * `seconds` is the length of the audio the second pass read.
 */
export function rescoreRejection(streamed: string, rescored: string, seconds: number): string | undefined {
  const norm = normalize(rescored);
  if (norm === normalize(streamed)) return undefined;
  if (STOCK_HALLUCINATIONS.has(rescored.replace(/[\s\p{P}]/gu, ""))) return "stock hallucination";
  const overlap = readingOverlap(streamed, rescored);
  if (seconds < SHORT_CLIP_S && overlap < MIN_OVERLAP) return `short clip ${seconds.toFixed(2)}s, overlap ${overlap.toFixed(2)}`;
  // The two readings agree on the sentence and differ by a name nobody said: the name is whisper's.
  // A wholesale disagreement on a long clip is still left to the second pass (the first was garble).
  const alien = alienKatakana(streamed, rescored);
  if (alien && overlap >= MIN_OVERLAP) return `katakana the first pass never heard: ${alien} (overlap ${overlap.toFixed(2)})`;
  return undefined;
}


/**
 * A katakana word of three characters or more that the first pass did not hear at all — in any
 * script. Whisper's names are the hallucinations that reach the reply: 「メタリオ」 for 「見たよ。」
 * (run 84), 「エリメ」 for a holey 「ア定ージ目…」 (run 90), 「リノース」 for 「昨日そう」 inside
 * 「ユイが昨日そう言ってたよね」 (run 100: 「リノースさんが言っていた内容について…」 was the answer).
 * A real katakana word the streaming recogniser wrote in kana or kanji still reads the same once both
 * are folded to hiragana (「スケジュール」 / 「すけじゅーる」); a name nobody said does not. The
 * streaming text keeps its reading; the rest of the rescore is lost with it, which is the cheaper error.
 */
export function alienKatakana(streamed: string, rescored: string): string | null {
  const heard = normalize(streamed);
  for (const run of rescored.match(/[ァ-ヶー]{3,}/g) ?? []) {
    const folded = normalize(run);
    if (!heard.includes(folded)) return run;
  }
  return null;
}
