import { planHeuristically, type MotionPlan, type MotionPlanInput } from "@rcai/behavior-engine";
import type { LLMAdapter } from "./adapters/llm.js";

const EMOTIONS = ["neutral", "smile", "laugh", "serious", "sad", "thinking", "surprised", "warm_positive", "concerned", "encourage"];
const GESTURES = ["nod_small", "nod_normal", "nod_strong", "head_tilt", "head_shake", "eyebrow_raise", "surprised", "happy", "laugh_soft", "concerned", "thinking", "encourage", "greeting", "bow", "goodbye", "celebrate", "wave", "point", "shrug"];

/** Semantic Motion Planner backed by the local LLM (JSON), heuristic on any failure. */
export async function planWithLocalLlm(input: MotionPlanInput, llm: LLMAdapter | null, timeoutMs = 1500): Promise<MotionPlan> {
  const fallback = planHeuristically(input);
  if (!llm?.ready) return fallback;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const text = await llm.complete(
      [
        { role: "system", content: `You label a sentence spoken by ${input.speaker} in a "${input.mode}" conversation for avatar animation. Reply with ONLY compact JSON: {"emotion": one of ${EMOTIONS.join("|")}, "emotionIntensity": 0..1, "gesture": one of ${GESTURES.join("|")} or null, "gestureIntensity": 0..1, "energy": 0..1}` },
        { role: "user", content: input.text },
      ],
      { maxTokens: 80, temperature: 0.1, json: true, signal: ctrl.signal },
    );
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<MotionPlan>;
    const emotion = EMOTIONS.includes(json.emotion as string) ? (json.emotion as MotionPlan["emotion"]) : fallback.emotion;
    const gesture = json.gesture && GESTURES.includes(json.gesture as string) ? (json.gesture as MotionPlan["gesture"]) : json.gesture === null ? null : fallback.gesture;
    const c = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
    return { emotion, emotionIntensity: c(json.emotionIntensity, fallback.emotionIntensity), gesture, gestureIntensity: c(json.gestureIntensity, fallback.gestureIntensity), energy: c(json.energy, fallback.energy), question: fallback.question };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
