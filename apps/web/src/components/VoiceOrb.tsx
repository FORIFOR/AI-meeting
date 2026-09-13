import { useEffect, useRef, useState } from "react";
import type { AvatarState } from "@rcai/avatar-core";
import { SILENT_VOICE, VOICE_ORB_LABELS, voiceOrbState, type VoiceLevels, type VoiceOrbState, type VoicePhase } from "../session/voiceActivity.js";
import { orbProfile } from "./voice-orb/profile.js";
import type { OrbRenderer } from "./voice-orb/renderer.js";
import "./voice-orb/voice-orb.css";

export interface VoiceOrbProps {
  avatarState: AvatarState;
  phase: VoicePhase;
  muted?: boolean;
  readLevels?: () => VoiceLevels;
  className?: string;
}

/** A persistent, accessible voice status, independent of the character renderer. */
export function VoiceOrb(props: VoiceOrbProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const initial = voiceOrbState(props.avatarState, props.phase, !!props.muted, SILENT_VOICE);
  const [state, setState] = useState<VoiceOrbState>(initial);
  const [backend, setBackend] = useState("fallback");
  useEffect(() => {
    const element = root.current;
    const surface = canvas.current;
    if (!element || !surface || typeof requestAnimationFrame !== "function") return;
    const abort = new AbortController();
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: true, addEventListener() {}, removeEventListener() {} };
    let renderer: OrbRenderer | null = null;
    let disposed = false;
    let raf = 0;
    let last = 0;
    let visible = true;
    let shown = initial;
    let energy = 0;
    let previousDraw = "";
    const draw = (now: number) => {
      if (disposed || document.hidden || !visible) { raf = 0; return; }
      raf = requestAnimationFrame(draw);
      if (last && now - last < 1000 / 30) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 30;
      last = now;
      const p = latest.current;
      const levels = p.readLevels?.() ?? SILENT_VOICE;
      const next = voiceOrbState(p.avatarState, p.phase, !!p.muted, levels);
      if (next !== shown) { shown = next; setState(next); }
      const target = next === "listening" ? levels.input : next === "speaking" ? levels.output : 0;
      energy += (target - energy) * (1 - Math.exp(-dt / 0.08));
      element.style.setProperty("--orb-energy", motion.matches ? "0" : energy.toFixed(3));
      const profile = orbProfile(next, motion.matches ? 0 : energy);
      // Reduced motion and inactive states render once per state/size change.
      const key = `${next}:${surface.clientWidth}:${motion.matches}`;
      if (!motion.matches && profile.speed > 0 || previousDraw !== key) {
        renderer?.draw(profile, dt, motion.matches);
        previousDraw = key;
      }
    };
    const resume = () => { last = 0; previousDraw = ""; if (!raf && !document.hidden && visible) raf = requestAnimationFrame(draw); };
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible) resume();
    }) : null;
    observer?.observe(element);
    document.addEventListener("visibilitychange", resume);
    motion.addEventListener("change", resume);
    const deadline = setTimeout(() => { if (!renderer) abort.abort(); }, 5000);
    // GPU failure affects the illustration only. Voice and the CSS glass fallback keep working.
    void import("./voice-orb/renderer.js").then(module => module.createVoiceOrbRenderer(surface, abort.signal, () => {
      if (!disposed) { renderer = null; setBackend("fallback"); }
    })).then(value => {
      clearTimeout(deadline);
      if (abort.signal.aborted) { value?.dispose(); return; }
      renderer = value;
      if (value) { previousDraw = ""; setBackend("webgpu"); }
    }).catch(() => { clearTimeout(deadline); });
    resume();
    return () => {
      disposed = true; clearTimeout(deadline); abort.abort(); cancelAnimationFrame(raf); renderer?.dispose(); observer?.disconnect();
      document.removeEventListener("visibilitychange", resume); motion.removeEventListener("change", resume);
    };
    // This effect owns one canvas lifetime; live session values are read through latest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={root} className={`voice-orb ${props.className ?? ""}`} data-state={state} data-renderer={backend}>
    <div className="voice-orb__visual" aria-hidden="true">
      <div className="voice-orb__fallback"><i /><i /><i /></div>
      <canvas ref={canvas} className="voice-orb__canvas" />
    </div>
    <span className="voice-orb__label" role="status" aria-live="polite" aria-atomic="true">{VOICE_ORB_LABELS[state]}</span>
  </div>;
}
