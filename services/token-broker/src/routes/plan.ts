import { planHeuristically, type MotionPlan, type MotionPlanInput } from "@rcai/behavior-engine";
import type { BrokerEnv } from "../env.js";

const EMOTIONS = ["neutral", "smile", "laugh", "serious", "sad", "thinking", "surprised", "warm_positive", "concerned", "encourage"];
const GESTURES = ["nod_small", "nod_normal", "nod_strong", "head_tilt", "head_shake", "eyebrow_raise", "surprised", "happy", "laugh_soft", "concerned", "thinking", "encourage", "greeting", "bow", "goodbye", "celebrate", "wave", "point", "shrug"];

/** Cloud Semantic Motion Planner (OpenAI chat completions, JSON mode). Always falls back to the heuristic. */
export async function planWithOpenAI(env: BrokerEnv, input: MotionPlanInput, fetchImpl: typeof fetch, timeoutMs = 1500): Promise<{ plan: MotionPlan; source: "openai" | "heuristic" }> {
  const fallback = planHeuristically(input);
  if (!env.OPENAI_API_KEY || !input.text?.trim()) return { plan: fallback, source: "heuristic" };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_PLAN_MODEL ?? "gpt-4.1-mini",
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `You plan an animated character's reaction to one utterance. Reply with JSON {"emotion": one of ${JSON.stringify(EMOTIONS)}, "emotionIntensity": 0..1, "gesture": one of ${JSON.stringify(GESTURES)} or null, "gestureIntensity": 0..1, "energy": 0..1, "question": boolean}. Mode "${input.mode}". Keep interview mode subtle.` },
          { role: "user", content: JSON.stringify({ speaker: input.speaker, text: input.text }) },
        ],
      }),
    });
    if (!res.ok) return { plan: fallback, source: "heuristic" };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const parsed = JSON.parse(json.choices?.[0]?.message?.content ?? "{}") as Partial<MotionPlan>;
    const clamp = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
    return {
      source: "openai",
      plan: {
        emotion: EMOTIONS.includes(String(parsed.emotion)) ? (parsed.emotion as MotionPlan["emotion"]) : fallback.emotion,
        emotionIntensity: clamp(parsed.emotionIntensity, fallback.emotionIntensity),
        gesture: parsed.gesture === null ? null : GESTURES.includes(String(parsed.gesture)) ? (parsed.gesture as MotionPlan["gesture"]) : fallback.gesture,
        gestureIntensity: clamp(parsed.gestureIntensity, fallback.gestureIntensity),
        energy: clamp(parsed.energy, fallback.energy),
        question: typeof parsed.question === "boolean" ? parsed.question : fallback.question,
      },
    };
  } catch {
    return { plan: fallback, source: "heuristic" };
  } finally {
    clearTimeout(timer);
  }
}
