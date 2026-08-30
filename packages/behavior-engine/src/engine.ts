import type { ConversationEvent } from "@rcai/conversation-core";
import type { AvatarProvider, AvatarRuntime, AvatarState, Emotion, StateTransition } from "@rcai/avatar-core";
import { BlinkController, BreathingController, GazeController } from "./micro.js";
import { ListeningScheduler, type ListeningAction } from "./listening.js";
import { ListenerSemantics } from "./listenerSemantics.js";
import { HeuristicSemanticPlanner, planHeuristically, type MotionPlan, type SemanticMotionPlanner } from "./planner.js";
import { createRng } from "./rng.js";

export interface BehaviorEngineOptions {
  planner?: SemanticMotionPlanner;
  rng?: () => number;
  seed?: number;
  clock?: () => number;
  mode?: string;
  /** Tick interval for the micro loop (ms). Default 33. */
  tickMs?: number;
  /** "interval" | "manual" (tests call tick()) */
  scheduler?: "interval" | "manual";
  /** Emotion bias from the persona (e.g. interviewer = neutral). */
  baseEmotion?: Emotion;
  baseEmotionIntensity?: number;
}

/**
 * Behavior Engine (spec §15): two tiers.
 *  - Fast tier: local rules on unified events / state transitions (≈0 latency).
 *  - Semantic tier: async planner on sentence text; applied when it arrives, never awaited by audio.
 * Also generates the listening micro-behaviour, blink, gaze and breathing (spec §13).
 */
export class BehaviorEngine {
  private rng: () => number;
  private clock: () => number;
  private planner: SemanticMotionPlanner;
  private blink: BlinkController;
  private breath: BreathingController;
  private gaze: GazeController;
  private listening: ListeningScheduler;
  private listener: ListenerSemantics;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastTick: number;
  private lastListeningEval = 0;
  private listeningStartedAt = 0;
  private lastUserAudioAt = 0;
  private userEnergy = 0;
  private userTranscript = "";
  private assistantSentenceBuffer = "";
  private lastAction: ListeningAction["kind"] | undefined;
  private turnId = 0;
  private planAbort: AbortController | null = null;
  private currentEmotion: { emotion: Emotion; intensity: number };
  private lastPlan: MotionPlan | null = null;
  private log: { at: number; what: string }[] = [];
  mode: string;

  constructor(private readonly avatar: AvatarRuntime, private readonly opts: BehaviorEngineOptions = {}) {
    this.rng = opts.rng ?? createRng(opts.seed);
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.planner = opts.planner ?? new HeuristicSemanticPlanner();
    const now = this.clock();
    this.lastTick = now;
    this.blink = new BlinkController(this.rng, now);
    this.breath = new BreathingController(this.rng);
    this.gaze = new GazeController(this.rng, now);
    this.listening = new ListeningScheduler(this.rng);
    this.listener = new ListenerSemantics(this.clock);
    this.mode = opts.mode ?? "free_talk";
    this.currentEmotion = { emotion: opts.baseEmotion ?? "warm_positive", intensity: opts.baseEmotionIntensity ?? 0.25 };
  }

  private get provider(): AvatarProvider {
    return this.avatar.avatar;
  }

  start(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.avatar.onStateChange((t) => this.onTransition(t));
    this.provider.setEmotion(this.currentEmotion.emotion, this.currentEmotion.intensity);
    if ((this.opts.scheduler ?? "interval") === "interval") {
      this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? 33);
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.planAbort?.abort();
  }

  getLog(): { at: number; what: string }[] {
    return [...this.log];
  }

  getLastPlan(): MotionPlan | null {
    return this.lastPlan;
  }

  /** Feed mic level (0..1) so listening reactions follow the user's energy. */
  reportUserAudio(level01: number, at: number = this.clock()): void {
    if (level01 > 0.05) this.lastUserAudioAt = at;
    this.userEnergy = this.userEnergy * 0.8 + level01 * 0.2;
  }

  /** Fast tier + semantic tier entry point. */
  handleEvent(event: ConversationEvent): void {
    const now = this.clock();
    switch (event.type) {
      case "user_transcript": {
        this.userTranscript = event.text;
        // Fast tier: listener semantics on the same tick (partial + final) — never waits for a remote plan.
        const r = this.listener.update(event.text, event.final !== false);
        if (r.expression && this.avatar.state === "LISTENING") this.applyListenerReading(r.expression, now);
        if (r.gesture && this.avatar.state === "LISTENING") {
          this.provider.performGesture(r.gesture.gesture, r.gesture.intensity);
          this.note(now, `listen:semantic-gesture:${r.gesture.gesture}`);
        }
        if (event.final !== false && event.text.trim()) this.planUserText(event.text);
        break;
      }
      case "assistant_transcript": {
        // Accumulate deltas; plan per sentence so gestures land on the right phrase.
        if (event.final === false) this.assistantSentenceBuffer += event.text;
        else this.assistantSentenceBuffer = event.text;
        const m = this.assistantSentenceBuffer.match(/^(.*?[。！？!?\.]+)(\s*)(.*)$/s);
        const sentence = m ? m[1]! : event.final === false ? "" : this.assistantSentenceBuffer;
        if (sentence.trim()) {
          this.assistantSentenceBuffer = m ? m[3]! : "";
          // Fast: question → eyebrow raise / question posture immediately.
          const h = planHeuristically({ speaker: "assistant", text: sentence, mode: this.mode });
          if (h.question) {
            this.provider.performGesture("eyebrow_raise", 0.4);
            this.provider.playMotion?.("speaking", { tags: ["question"], energy: h.energy });
            this.note(now, "fast:question");
          }
          void this.planAssistantText(sentence);
        }
        break;
      }
      case "assistant_speech_started":
        this.turnId++;
        this.assistantSentenceBuffer = "";
        break;
      case "interrupted":
        this.planAbort?.abort();
        this.provider.setEmotion("neutral", 0);
        this.provider.setGaze({ kind: "user" });
        this.note(now, "fast:interrupted→listening");
        break;
      case "session_closed":
        this.stop();
        break;
      default:
        break;
    }
  }

  private onTransition(t: StateTransition): void {
    const now = t.at;
    this.blink.nudge(now, 300);
    switch (t.to) {
      case "LISTENING":
        this.listeningStartedAt = now;
        this.listening.reset(now);
        this.listener.reset();
        this.userTranscript = "";
        this.lastAction = undefined;
        this.provider.setGaze({ kind: "user" });
        this.provider.setEmotion(this.currentEmotion.emotion, Math.min(0.35, this.currentEmotion.intensity));
        this.note(now, "fast:listening posture");
        break;
      case "THINKING":
        this.provider.setEmotion("thinking", 0.35);
        this.note(now, "fast:thinking");
        break;
      case "SPEAKING":
        this.provider.setEmotion(this.currentEmotion.emotion, this.currentEmotion.intensity);
        this.provider.setGaze({ kind: "user" });
        this.note(now, "fast:speaking posture");
        break;
      case "IDLE":
        this.provider.setEmotion(this.currentEmotion.emotion, this.currentEmotion.intensity * 0.6);
        break;
      default:
        break;
    }
  }

  /** Micro loop: blink / breathing / gaze / listening reactions. */
  tick(now: number = this.clock()): void {
    const dt = Math.max(1, now - this.lastTick);
    this.lastTick = now;
    const state: AvatarState = this.avatar.state;

    const blinkMs = this.blink.update(now, state);
    if (blinkMs !== null) this.provider.blink?.(blinkMs);

    this.provider.setMicroMotion?.(this.breath.update(dt, state));

    const gaze = this.gaze.update(now, state);
    if (gaze) {
      this.provider.setGaze(gaze);
      if (gaze.kind !== "user") this.blink.suppress(now, 250);
    }

    if (state === "LISTENING" && now - this.lastListeningEval >= 250) {
      this.lastListeningEval = now;
      const action = this.listening.next(now, {
        elapsedMs: now - this.listeningStartedAt,
        sinceUserAudioMs: now - this.lastUserAudioAt,
        userEnergy: this.userEnergy,
        transcript: this.userTranscript,
        emotion: this.listener.reading.category === "neutral" ? this.lastPlan?.emotion : this.listener.reading.emotion,
        category: this.listener.reading.category,
        nodRate: this.listener.reading.nodRate,
        lastAction: this.lastAction,
      });
      if (action) this.applyListeningAction(action, now);
    }
  }

  private applyListeningAction(action: ListeningAction, now: number): void {
    this.lastAction = action.kind;
    switch (action.kind) {
      case "tiny_nod":
      case "head_tilt":
      case "brow":
        this.provider.performGesture(action.gesture, action.intensity);
        break;
      case "gaze_shift":
        this.provider.setGaze({ kind: "away", x: (this.rng() - 0.5) * 0.4 });
        break;
      case "posture":
        this.provider.playMotion?.("listening", { tags: action.tags, energy: 0.3 });
        break;
    }
    this.note(now, `listen:${action.kind}`);
  }

  /** Listener Semantics → listening expression (low intensity; the avatar is listening, not performing). */
  private applyListenerReading(r: import("./listenerSemantics.js").ListenerReading, now: number): void {
    this.provider.setEmotion(r.emotion, r.emotionIntensity);
    if (r.gazeSoften) this.provider.setGaze({ kind: "down", y: -0.18 });
    else this.provider.setGaze({ kind: "user" });
    if (r.suppressSmile) this.currentEmotion = { emotion: r.emotion, intensity: Math.min(0.4, r.emotionIntensity) };
    this.note(now, `listen:semantic:${r.category}`);
  }

  /** Optional async refinement of the final user transcript; never overrides a negative reading with a smile. */
  private planUserText(text: string): void {
    const reading = this.listener.reading;
    if (reading.suppressSmile) {
      this.lastPlan = { emotion: reading.emotion, emotionIntensity: reading.emotionIntensity, gesture: null, gestureIntensity: 0, energy: 0.25 };
      return;
    }
    const h = planHeuristically({ speaker: "user", text, mode: this.mode });
    if (h.emotion === "surprised" || h.emotion === "laugh") {
      this.provider.setEmotion(h.emotion, Math.min(0.5, h.emotionIntensity));
      this.lastPlan = h;
    }
    if (this.opts.planner && !(this.planner instanceof HeuristicSemanticPlanner)) {
      const cat = reading.category;
      void this.planner
        .plan({ speaker: "user", text, mode: this.mode })
        .then((plan) => {
          // Remote refinement may only *soften*; it can never turn a serious/negative reading into a smile.
          if (this.avatar.state !== "LISTENING") return;
          if (["laugh", "smile", "happy", "warm_positive", "encourage"].includes(plan.emotion) && (cat === "emotional_negative" || cat === "serious")) return;
          this.provider.setEmotion(plan.emotion, Math.min(0.45, plan.emotionIntensity));
        })
        .catch(() => {});
    }
  }

  private async planAssistantText(sentence: string): Promise<void> {
    const turn = this.turnId;
    this.planAbort?.abort();
    const abort = new AbortController();
    this.planAbort = abort;
    try {
      const plan = await this.planner.plan({ speaker: "assistant", text: sentence, mode: this.mode }, abort.signal);
      if (abort.signal.aborted || turn !== this.turnId) return; // stale (interrupted / next turn)
      this.lastPlan = plan;
      this.currentEmotion = { emotion: plan.emotion, intensity: plan.emotionIntensity };
      this.provider.setEmotion(plan.emotion, plan.emotionIntensity);
      if (plan.gesture) this.provider.performGesture(plan.gesture, plan.gestureIntensity);
      if (this.avatar.state === "SPEAKING") this.provider.playMotion?.("speaking", { energy: plan.energy, tags: plan.question ? ["question"] : plan.emotion === "serious" ? ["serious"] : undefined });
      this.note(this.clock(), `semantic:${plan.emotion}/${plan.gesture ?? "-"}`);
    } catch {
      /* planner failures never affect playback */
    }
  }

  private note(at: number, what: string): void {
    this.log.push({ at, what });
    if (this.log.length > 500) this.log.shift();
  }
}
