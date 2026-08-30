import type { Emotion, Gesture } from "@rcai/avatar-core";

/**
 * Listener Semantics: what the *user* is saying while the avatar listens.
 * Synchronous lexicon classification (fast tier) — the listening expression must react on the
 * same tick as the transcript, never after a remote plan (spec §13/§15).
 */
export type ListenerCategory = "positive" | "serious" | "surprising" | "uncertain" | "emotional_negative" | "neutral";

export interface ListenerReading {
  category: ListenerCategory;
  /** 0..1 */
  intensity: number;
  /** Listening expression to show right now (low intensity — the avatar is listening, not reacting). */
  emotion: Emotion;
  emotionIntensity: number;
  /** Optional immediate micro reaction. */
  gesture: Gesture | null;
  gestureIntensity: number;
  /** Nod cadence multiplier for the ListeningScheduler (1 = default, <1 slower). */
  nodRate: number;
  /** True when smiles/laughs must be suppressed (the user is describing something painful). */
  suppressSmile: boolean;
  /** Gaze softening hint (slightly down) for emotional content. */
  gazeSoften: boolean;
  matched: string[];
}

interface Cue {
  re: RegExp;
  category: ListenerCategory;
  weight: number;
}

// Order matters only through weights; negative/serious cues outrank positive ones so
// "頑張ったけど失敗した" reads as emotional_negative, not positive.
const CUES: Cue[] = [
  // emotional negative (loss, failure, pain)
  { re: /(失敗|うまくいかな|ダメになっ|辛かっ|つらかっ|つらく|苦し|泣|亡くな|落ち込|挫折|クビ|解雇|後悔|悔し|傷つ|しんどか|限界)/, category: "emotional_negative", weight: 4 },
  { re: /\b(failed|failure|didn'?t work|fell apart|painful|cried|passed away|lost my|got fired|laid off|regret|struggl(ed|ing)|burn(ed|t) out)\b/i, category: "emotional_negative", weight: 4 },
  // serious (problems, risk, conflict, hard topics without explicit pain)
  { re: /(問題|課題|リスク|トラブル|クレーム|炎上|遅延|赤字|対立|衝突|批判|厳し|深刻|難し|大変|プレッシャー|責任)/, category: "serious", weight: 3 },
  { re: /\b(problem|issue|risk|conflict|complaint|serious|difficult|hard time|pressure|deadline|critical|escalat)/i, category: "serious", weight: 3 },
  // surprising
  { re: /(実は|まさか|びっくり|驚|信じられな|突然|急に|いきなり|なんと|偶然)/, category: "surprising", weight: 3 },
  { re: /\b(actually|surprisingly|suddenly|out of nowhere|believe it or not|turns out|unexpected)/i, category: "surprising", weight: 3 },
  // uncertain / hedging
  { re: /(えっと|えーと|ええと|うーん|たぶん|多分|かもしれ|かも[。、\s]|わからな|分からな|どうだろ|自信がな|なんとなく|微妙|かな[ぁ…。、]?$)/, category: "uncertain", weight: 2 },
  { re: /\b(um+|uh+|maybe|perhaps|not sure|i guess|i think so|kind of|sort of|dunno|probably)\b/i, category: "uncertain", weight: 2 },
  // positive / achievement
  { re: /(成功|達成|改善|短縮|増加|向上|受賞|表彰|昇進|まとめ(て|た)|率い|リード|嬉し|楽し|好き|良かっ|よかっ|ありがた|感謝|できました|できた|やり遂げ)/, category: "positive", weight: 2 },
  { re: /\b(succeeded|achieved|improved|reduced|increased|grew|led|managed|awarded|promoted|happy|glad|love|enjoy|proud|great|excited)\b/i, category: "positive", weight: 2 },
  { re: /(笑|www|はは|あはは|lol|haha)/i, category: "positive", weight: 2 },
];

const NUMBER_ACHIEVEMENT = /(\d+|[一二三四五六七八九十百千万]+)\s*(人|名|件|%|％|倍|割|万円|億|年|か月|ヶ月|ユーザー|users|people|percent|x)/;

export function classifyListener(text: string): ListenerReading {
  const t = text.trim();
  const scores: Record<ListenerCategory, number> = { positive: 0, serious: 0, surprising: 0, uncertain: 0, emotional_negative: 0, neutral: 0 };
  const matched: string[] = [];
  // Weight recent text more: look at the tail (last ~40 chars) with 1.5× weight in addition to the whole text.
  const tail = t.slice(-40);
  for (const cue of CUES) {
    const whole = cue.re.test(t);
    const recent = cue.re.test(tail);
    if (whole) {
      scores[cue.category] += cue.weight * (recent ? 1.5 : 1);
      matched.push(cue.re.source.slice(0, 24));
    }
  }
  if (NUMBER_ACHIEVEMENT.test(t) && scores.emotional_negative === 0) scores.positive += 1.5;
  const exclam = (t.match(/[!！]/g) ?? []).length;
  if (exclam) scores.positive += exclam * 0.5;

  // Negative emotion dominates: a smile on "失敗してしまって" breaks presence instantly.
  let category: ListenerCategory = "neutral";
  let best = 0;
  for (const k of ["emotional_negative", "serious", "surprising", "uncertain", "positive"] as ListenerCategory[]) {
    if (scores[k] > best) {
      best = scores[k];
      category = k;
    }
  }
  if (scores.emotional_negative > 0 && scores.emotional_negative >= scores[category] * 0.6) category = "emotional_negative";
  const intensity = Math.min(1, best / 6);
  return { ...readingFor(category, intensity), category, intensity, matched };
}

function readingFor(category: ListenerCategory, intensity: number): Omit<ListenerReading, "category" | "intensity" | "matched"> {
  switch (category) {
    case "emotional_negative":
      return { emotion: "concerned", emotionIntensity: 0.35 + intensity * 0.3, gesture: "nod_small", gestureIntensity: 0.25, nodRate: 0.6, suppressSmile: true, gazeSoften: true };
    case "serious":
      return { emotion: "serious", emotionIntensity: 0.25 + intensity * 0.25, gesture: null, gestureIntensity: 0, nodRate: 0.7, suppressSmile: true, gazeSoften: false };
    case "surprising":
      return { emotion: "surprised", emotionIntensity: 0.3 + intensity * 0.3, gesture: "eyebrow_raise", gestureIntensity: 0.45, nodRate: 1, suppressSmile: false, gazeSoften: false };
    case "uncertain":
      return { emotion: "thinking", emotionIntensity: 0.2 + intensity * 0.2, gesture: "head_tilt", gestureIntensity: 0.4, nodRate: 0.8, suppressSmile: false, gazeSoften: false };
    case "positive":
      return { emotion: "warm_positive", emotionIntensity: 0.3 + intensity * 0.3, gesture: intensity > 0.5 ? "nod_normal" : "nod_small", gestureIntensity: 0.3 + intensity * 0.3, nodRate: 1.2, suppressSmile: false, gazeSoften: false };
    default:
      return { emotion: "warm_positive", emotionIntensity: 0.2, gesture: null, gestureIntensity: 0, nodRate: 1, suppressSmile: false, gazeSoften: false };
  }
}

/**
 * Stateful wrapper: debounces expression changes on partial transcripts so the face does not
 * flicker while the STT revises words, and remembers the category for the scheduler.
 */
export class ListenerSemantics {
  private current: ListenerReading = classifyListener("");
  private lastGestureAt = -1e9;
  private lastCategory: ListenerCategory = "neutral";

  constructor(private readonly clock: () => number) {}

  get reading(): ListenerReading {
    return this.current;
  }

  reset(): void {
    this.current = classifyListener("");
    this.lastCategory = "neutral";
  }

  /** Returns what changed: expression to apply (or null) and a gesture to fire (or null). */
  update(text: string, final: boolean): { expression: ListenerReading | null; gesture: { gesture: Gesture; intensity: number } | null } {
    const now = this.clock();
    const next = classifyListener(text);
    const changed = next.category !== this.lastCategory || Math.abs(next.intensity - this.current.intensity) > 0.25 || final;
    this.current = next;
    if (!changed && !final) return { expression: null, gesture: null };
    let gesture: { gesture: Gesture; intensity: number } | null = null;
    if (next.gesture && next.category !== this.lastCategory && now - this.lastGestureAt > 1500 && next.category !== "neutral") {
      gesture = { gesture: next.gesture, intensity: next.gestureIntensity };
      this.lastGestureAt = now;
    }
    this.lastCategory = next.category;
    return { expression: next, gesture };
  }
}
