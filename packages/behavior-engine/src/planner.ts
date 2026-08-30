import type { Emotion, Gesture } from "@rcai/avatar-core";

/** Spec §15 Semantic Motion Planner I/O. */
export interface MotionPlanInput {
  speaker: "assistant" | "user";
  text: string;
  mode: string;
  language?: string;
}

export interface MotionPlan {
  emotion: Emotion;
  emotionIntensity: number;
  gesture: Gesture | null;
  gestureIntensity: number;
  /** 0..1 overall energy used to pick speaking clips. */
  energy: number;
  /** True when the utterance is a question. */
  question?: boolean;
}

export interface SemanticMotionPlanner {
  plan(input: MotionPlanInput, signal?: AbortSignal): Promise<MotionPlan>;
}

interface Rule {
  re: RegExp;
  emotion: Emotion;
  gesture: Gesture | null;
  weight: number;
  energy: number;
}

const RULES: Rule[] = [
  { re: /(素晴らしい|すごく良い|とても良い|いいですね|良い(回答|視点|質問)|great|excellent|wonderful|nice one|well done)/i, emotion: "warm_positive", gesture: "nod_normal", weight: 3, energy: 0.55 },
  { re: /(おめでとう|やった|congrat|やりましたね|最高)/i, emotion: "laugh", gesture: "celebrate", weight: 4, energy: 0.9 },
  { re: /(笑|はは|www|lol|haha|面白い|funny)/i, emotion: "laugh", gesture: "laugh_soft", weight: 3, energy: 0.7 },
  { re: /(残念|大変|つらい|悲しい|sorry to hear|that's hard|難しい状況)/i, emotion: "concerned", gesture: "concerned", weight: 3, energy: 0.3 },
  { re: /(えっ|本当に|まじ|驚|びっくり|すごい|really\?|wow|surpris)/i, emotion: "surprised", gesture: "surprised", weight: 3, energy: 0.7 },
  { re: /(うーん|そうですね[、。]?\s*(えっと|少し)|考え|let me think|hmm|難しい質問)/i, emotion: "thinking", gesture: "thinking", weight: 2, energy: 0.3 },
  { re: /(大丈夫|できます|頑張|応援|you can do it|keep going|don't worry)/i, emotion: "encourage", gesture: "encourage", weight: 3, energy: 0.6 },
  { re: /(重要|注意|気をつけ|問題|リスク|important|careful|serious)/i, emotion: "serious", gesture: null, weight: 2, energy: 0.35 },
  { re: /(ありがとう|thank)/i, emotion: "smile", gesture: "nod_small", weight: 2, energy: 0.45 },
  { re: /(こんにちは|はじめまして|よろしく|hello|hi there|nice to meet)/i, emotion: "smile", gesture: "greeting", weight: 2, energy: 0.6 },
  { re: /(さようなら|またね|お疲れ|bye|see you)/i, emotion: "smile", gesture: "goodbye", weight: 2, energy: 0.55 },
  { re: /(例えば|つまり|ポイントは|理由は|for example|the point is|because)/i, emotion: "neutral", gesture: "point", weight: 1, energy: 0.5 },
  { re: /(そうですね|なるほど|わかります|i see|makes sense)/i, emotion: "warm_positive", gesture: "nod_small", weight: 1, energy: 0.4 },
];

/**
 * Local lexicon planner: zero network, sub-millisecond. Used as the default and as the
 * fallback while a remote LLM planner is in flight.
 */
export class HeuristicSemanticPlanner implements SemanticMotionPlanner {
  async plan(input: MotionPlanInput): Promise<MotionPlan> {
    return planHeuristically(input);
  }
}

export function planHeuristically(input: MotionPlanInput): MotionPlan {
  const text = input.text.trim();
  const question = /[？?]\s*$/.test(text) || /(ですか|ますか|でしょうか|かな)[。]?$/.test(text);
  let best: Rule | null = null;
  for (const r of RULES) if (r.re.test(text) && (!best || r.weight > best.weight)) best = r;
  const exclam = (text.match(/[!！]/g) ?? []).length;
  const base: MotionPlan = best
    ? { emotion: best.emotion, emotionIntensity: Math.min(0.85, 0.35 + best.weight * 0.12 + exclam * 0.1), gesture: best.gesture, gestureIntensity: Math.min(0.9, 0.3 + best.weight * 0.1), energy: Math.min(1, best.energy + exclam * 0.1) }
    : { emotion: input.mode === "interview" ? "neutral" : "warm_positive", emotionIntensity: input.mode === "interview" ? 0.2 : 0.3, gesture: null, gestureIntensity: 0, energy: 0.4 + exclam * 0.1 };
  if (question && !base.gesture) base.gesture = "head_tilt";
  if (question) base.gestureIntensity = Math.max(base.gestureIntensity, 0.35);
  if (input.mode === "interview") base.energy = Math.min(base.energy, 0.55);
  return { ...base, question };
}

/**
 * Remote planner (e.g. services/agent `/plan` backed by a local or cloud LLM).
 * Falls back to the heuristic on error/timeout so animation never stalls.
 */
export class RemoteSemanticPlanner implements SemanticMotionPlanner {
  constructor(private readonly url: string, private readonly timeoutMs = 1500, private readonly fetchImpl: typeof fetch = fetch) {}

  async plan(input: MotionPlanInput, signal?: AbortSignal): Promise<MotionPlan> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    signal?.addEventListener("abort", () => ctrl.abort());
    try {
      const res = await this.fetchImpl(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: ctrl.signal });
      if (!res.ok) throw new Error(`planner ${res.status}`);
      const json = (await res.json()) as Partial<MotionPlan>;
      const h = planHeuristically(input);
      return {
        emotion: (json.emotion as Emotion) ?? h.emotion,
        emotionIntensity: clamp01(json.emotionIntensity ?? h.emotionIntensity),
        gesture: (json.gesture as Gesture) ?? h.gesture,
        gestureIntensity: clamp01(json.gestureIntensity ?? h.gestureIntensity),
        energy: clamp01(json.energy ?? h.energy),
        question: json.question ?? h.question,
      };
    } catch {
      return planHeuristically(input);
    } finally {
      clearTimeout(timer);
    }
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
