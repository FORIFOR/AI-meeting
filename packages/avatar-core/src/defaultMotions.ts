import type { Keyframe, MotionClip } from "./motion.js";
import type { ParamName } from "./types.js";

/** Helper: sinusoidal loop curve sampled into keyframes. */
function sine(durationMs: number, amp: number, phase = 0, steps = 16, offset = 0): Keyframe[] {
  const out: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * durationMs;
    out.push({ t, v: offset + amp * Math.sin(phase + (2 * Math.PI * i) / steps), ease: "inOut" });
  }
  return out;
}

function pulse(durationMs: number, amp: number, peakAt = 0.4, ease: Keyframe["ease"] = "inOut"): Keyframe[] {
  return [
    { t: 0, v: 0 },
    { t: durationMs * peakAt, v: amp, ease },
    { t: durationMs, v: 0, ease },
  ];
}

function clip(id: string, category: MotionClip["category"], durationMs: number, loop: boolean, curves: Partial<Record<ParamName, Keyframe[]>>, extra: Partial<MotionClip> = {}): MotionClip {
  return { id, category, durationMs, loop, curves, fadeInMs: loop ? 400 : 120, fadeOutMs: loop ? 400 : 250, ...extra };
}

/**
 * Spec §12: 30+ renderer-agnostic motions. Character packs may add/override via JSON.
 */
export function createDefaultMotions(): MotionClip[] {
  return [
    // ---- Idle
    clip("idle_breathe", "idle", 4200, true, { breath: sine(4200, 0.5, -Math.PI / 2, 16, 0.5), bodyAngleY: sine(4200, 0.4) }, { energy: 0.1 }),
    clip("idle_soft_sway", "idle", 6000, true, { bodyAngleX: sine(6000, 1.2), angleZ: sine(6000, 1.5, 1), breath: sine(6000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.2 }),
    clip("idle_look_left", "idle", 5000, false, { angleX: [{ t: 0, v: 0 }, { t: 900, v: -8, ease: "inOut" }, { t: 3600, v: -8 }, { t: 5000, v: 0, ease: "inOut" }], eyeBallX: [{ t: 0, v: 0 }, { t: 600, v: -0.5 }, { t: 3600, v: -0.5 }, { t: 4600, v: 0 }] }, { energy: 0.2 }),
    clip("idle_look_right", "idle", 5000, false, { angleX: [{ t: 0, v: 0 }, { t: 900, v: 8, ease: "inOut" }, { t: 3600, v: 8 }, { t: 5000, v: 0, ease: "inOut" }], eyeBallX: [{ t: 0, v: 0 }, { t: 600, v: 0.5 }, { t: 3600, v: 0.5 }, { t: 4600, v: 0 }] }, { energy: 0.2 }),
    clip("idle_relaxed", "idle", 7000, true, { angleY: sine(7000, 1.5), bodyAngleZ: sine(7000, 0.8, 2), shoulder: sine(7000, 0.1), breath: sine(7000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.1 }),

    // ---- Listening
    clip("listen_neutral", "listening", 5000, true, { angleY: sine(5000, 1.0, 0, 16, 1.5), breath: sine(5000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.2 }),
    clip("listen_small_nod", "listening", 1400, false, { angleY: [{ t: 0, v: 0 }, { t: 350, v: -4, ease: "out" }, { t: 750, v: 1.5, ease: "inOut" }, { t: 1400, v: 0, ease: "inOut" }] }, { energy: 0.3, tags: ["nod"] }),
    clip("listen_interested", "listening", 5000, true, { angleY: sine(5000, 0.8, 0, 16, 3), bodyAngleY: sine(5000, 0.5, 0, 16, 1), browLY: sine(5000, 0.05, 0, 16, 0.15), browRY: sine(5000, 0.05, 0, 16, 0.15), breath: sine(5000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.4 }),
    clip("listen_head_tilt", "listening", 3200, false, { angleZ: [{ t: 0, v: 0 }, { t: 700, v: 7, ease: "inOut" }, { t: 2400, v: 7 }, { t: 3200, v: 0, ease: "inOut" }], angleX: [{ t: 0, v: 0 }, { t: 700, v: 2 }, { t: 3200, v: 0 }] }, { energy: 0.3, tags: ["tilt"] }),
    clip("listen_serious", "listening", 6000, true, { angleY: sine(6000, 0.6, 0, 16, 0.5), browLY: sine(6000, 0.03, 0, 16, -0.2), browRY: sine(6000, 0.03, 0, 16, -0.2), breath: sine(6000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.15, tags: ["serious"] }),
    clip("listen_long_answer", "listening", 8000, true, { angleY: sine(8000, 1.2, 0, 24, 2), angleX: sine(8000, 1.5, 1.2), bodyAngleX: sine(8000, 0.6, 2), breath: sine(8000, 0.5, -Math.PI / 2, 24, 0.5) }, { energy: 0.25 }),

    // ---- Thinking
    clip("think_look_up", "thinking", 4000, true, { angleY: sine(4000, 0.5, 0, 16, 4), angleZ: sine(4000, 0.8, 0, 16, -4), eyeBallY: sine(4000, 0.05, 0, 16, 0.45), eyeBallX: sine(4000, 0.05, 0, 16, 0.3), breath: sine(4000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.2 }),
    clip("think_hmm", "thinking", 3500, true, { angleZ: sine(3500, 1, 0, 16, 5), browLY: sine(3500, 0.05, 0, 16, 0.2), eyeBallY: sine(3500, 0.05, 0, 16, 0.3), breath: sine(3500, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.2 }),

    // ---- Speaking
    clip("speak_calm", "speaking", 3000, true, { angleY: sine(3000, 1.2), angleX: sine(3000, 0.8, 1), bodyAngleY: sine(3000, 0.3), breath: sine(3000, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.3 }),
    clip("speak_soft", "speaking", 3600, true, { angleY: sine(3600, 0.8, 0, 16, 1), angleZ: sine(3600, 1.5, 1), breath: sine(3600, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.25 }),
    clip("speak_energetic", "speaking", 1600, true, { angleY: sine(1600, 2.5), angleX: sine(1600, 2, 1.3), bodyAngleX: sine(1600, 1.2, 0.7), armR: sine(1600, 0.15, 0, 16, 0.1), breath: sine(1600, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.8 }),
    clip("speak_explain", "speaking", 2600, true, { angleY: sine(2600, 1.5, 0, 16, 1), angleX: sine(2600, 2.5, 0.8), armR: sine(2600, 0.25, 0, 16, 0.2), handR: sine(2600, 0.3, 1), breath: sine(2600, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.55 }),
    clip("speak_question", "speaking", 2800, true, { angleZ: sine(2800, 1.2, 0, 16, 4), angleY: sine(2800, 1, 0, 16, 1.5), browLY: sine(2800, 0.05, 0, 16, 0.3), browRY: sine(2800, 0.05, 0, 16, 0.3), breath: sine(2800, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.4, tags: ["question"] }),
    clip("speak_serious", "speaking", 3400, true, { angleY: sine(3400, 0.8, 0, 16, -1), browLY: sine(3400, 0.03, 0, 16, -0.25), browRY: sine(3400, 0.03, 0, 16, -0.25), breath: sine(3400, 0.5, -Math.PI / 2, 16, 0.5) }, { energy: 0.3, tags: ["serious"] }),

    // ---- Reaction
    clip("nod_small", "reaction", 900, false, { angleY: pulse(900, -4, 0.35, "out") }, { energy: 0.3, tags: ["nod"] }),
    clip("nod_normal", "reaction", 1100, false, { angleY: [{ t: 0, v: 0 }, { t: 300, v: -8, ease: "out" }, { t: 650, v: 2, ease: "inOut" }, { t: 1100, v: 0, ease: "inOut" }] }, { energy: 0.5, tags: ["nod"] }),
    clip("nod_strong", "reaction", 1500, false, { angleY: [{ t: 0, v: 0 }, { t: 250, v: -12, ease: "out" }, { t: 600, v: 3 }, { t: 900, v: -8 }, { t: 1500, v: 0, ease: "inOut" }], bodyAngleY: pulse(1500, -1.5, 0.3) }, { energy: 0.8, tags: ["nod"] }),
    clip("surprised", "reaction", 1300, false, { angleY: pulse(1300, 5, 0.15, "out"), eyeLOpen: pulse(1300, 0.35, 0.15, "out"), eyeROpen: pulse(1300, 0.35, 0.15, "out"), browLY: pulse(1300, 0.8, 0.15), browRY: pulse(1300, 0.8, 0.15), bodyAngleY: pulse(1300, 2, 0.15) }, { energy: 0.8 }),
    clip("happy", "reaction", 1800, false, { angleZ: [{ t: 0, v: 0 }, { t: 400, v: 6, ease: "out" }, { t: 1200, v: -3 }, { t: 1800, v: 0 }], cheek: pulse(1800, 0.6, 0.3), eyeLSmile: pulse(1800, 0.8, 0.3), eyeRSmile: pulse(1800, 0.8, 0.3), bodyAngleY: pulse(1800, 1.5, 0.3) }, { energy: 0.7, tags: ["positive"] }),
    clip("laugh_soft", "reaction", 1600, false, { angleY: sine(1600, 2, 0, 12, -3), bodyAngleY: sine(1600, 1.2, 0, 12), eyeLSmile: pulse(1600, 1, 0.3), eyeRSmile: pulse(1600, 1, 0.3), cheek: pulse(1600, 0.7, 0.3), shoulder: sine(1600, 0.2, 0, 12) }, { energy: 0.7, tags: ["positive"] }),
    clip("concerned", "reaction", 2200, false, { angleZ: pulse(2200, -5, 0.4), browLForm: pulse(2200, 0.5, 0.4), browRForm: pulse(2200, 0.5, 0.4), browLY: pulse(2200, -0.3, 0.4), browRY: pulse(2200, -0.3, 0.4), mouthForm: pulse(2200, -0.4, 0.4) }, { energy: 0.3, tags: ["negative"] }),
    clip("thinking", "reaction", 2600, false, { angleZ: pulse(2600, 6, 0.4), angleY: pulse(2600, 4, 0.4), eyeBallY: pulse(2600, 0.5, 0.35), eyeBallX: pulse(2600, 0.4, 0.35), browLY: pulse(2600, 0.3, 0.4) }, { energy: 0.3 }),
    clip("encourage", "reaction", 1800, false, { angleY: [{ t: 0, v: 0 }, { t: 350, v: -6, ease: "out" }, { t: 800, v: 2 }, { t: 1800, v: 0 }], armR: pulse(1800, 0.5, 0.4), handR: pulse(1800, 0.6, 0.4), eyeLSmile: pulse(1800, 0.5, 0.4), eyeRSmile: pulse(1800, 0.5, 0.4) }, { energy: 0.6, tags: ["positive"] }),
    clip("head_tilt", "reaction", 1800, false, { angleZ: pulse(1800, 8, 0.4) }, { energy: 0.3, tags: ["tilt"] }),
    clip("head_shake", "reaction", 1200, false, { angleX: [{ t: 0, v: 0 }, { t: 250, v: -7 }, { t: 600, v: 7 }, { t: 900, v: -4 }, { t: 1200, v: 0 }] }, { energy: 0.5, tags: ["negative"] }),
    clip("eyebrow_raise", "reaction", 900, false, { browLY: pulse(900, 0.6, 0.3, "out"), browRY: pulse(900, 0.6, 0.3, "out"), eyeLOpen: pulse(900, 0.15, 0.3), eyeROpen: pulse(900, 0.15, 0.3) }, { energy: 0.3 }),

    // ---- Social
    clip("greeting", "social", 2200, false, { angleY: [{ t: 0, v: 0 }, { t: 500, v: -10, ease: "out" }, { t: 1400, v: -8 }, { t: 2200, v: 0, ease: "inOut" }], armR: pulse(2200, 0.8, 0.4), handR: sine(2200, 0.4, 0, 12), eyeLSmile: pulse(2200, 0.7, 0.4), eyeRSmile: pulse(2200, 0.7, 0.4) }, { energy: 0.6 }),
    clip("bow", "social", 2400, false, { angleY: [{ t: 0, v: 0 }, { t: 600, v: -22, ease: "inOut" }, { t: 1500, v: -22 }, { t: 2400, v: 0, ease: "inOut" }], bodyAngleY: [{ t: 0, v: 0 }, { t: 600, v: -6, ease: "inOut" }, { t: 1500, v: -6 }, { t: 2400, v: 0, ease: "inOut" }] }, { energy: 0.4 }),
    clip("goodbye", "social", 2600, false, { armR: [{ t: 0, v: 0 }, { t: 400, v: 0.9 }, { t: 2200, v: 0.9 }, { t: 2600, v: 0 }], handR: sine(2600, 0.6, 0, 16), angleZ: pulse(2600, 4, 0.4), eyeLSmile: pulse(2600, 0.6, 0.4), eyeRSmile: pulse(2600, 0.6, 0.4) }, { energy: 0.6 }),
    clip("celebrate", "social", 2000, false, { armL: pulse(2000, 0.9, 0.3), armR: pulse(2000, 0.9, 0.3), angleY: pulse(2000, 6, 0.3), bodyAngleY: pulse(2000, 2, 0.3), cheek: pulse(2000, 0.8, 0.3), eyeLSmile: pulse(2000, 1, 0.3), eyeRSmile: pulse(2000, 1, 0.3) }, { energy: 0.9, tags: ["positive"] }),

    // ---- Teaching
    clip("teach_point", "teaching", 2200, false, { armR: pulse(2200, 0.7, 0.4), handR: pulse(2200, 0.8, 0.4), angleX: pulse(2200, 5, 0.4), eyeBallX: pulse(2200, 0.3, 0.4) }, { energy: 0.5 }),
    clip("teach_explain_hands", "teaching", 3000, true, { armL: sine(3000, 0.25, 0, 16, 0.2), armR: sine(3000, 0.25, Math.PI, 16, 0.2), angleY: sine(3000, 1.5) }, { energy: 0.5 }),
  ];
}
