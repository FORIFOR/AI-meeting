import type { LatencyTracker, PCMFrame } from "@rcai/audio-core";
import { GENERATION_EVENT_TYPES, type ConversationEvent } from "@rcai/conversation-core";
import { AvatarStateMachine, type StateTransition } from "./stateMachine.js";
import type { AvatarProvider, AvatarState, Emotion, Gesture, GazeTarget } from "./types.js";

export interface AvatarRuntimeOptions {
  latency?: LatencyTracker;
  clock?: () => number;
  /** REACTING bursts return to the previous state after this many ms (default 1200). */
  reactionMs?: number;
}

/**
 * Avatar Runtime (spec §2, §10): the only thing that talks to an AvatarProvider.
 * Input: ConversationEvent (never provider-native) + played PCM. Output: provider calls.
 */
export class AvatarRuntime {
  readonly machine: AvatarStateMachine;
  private provider: AvatarProvider;
  private clock: () => number;
  private reactionTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListeners = new Set<(t: StateTransition) => void>();
  private lastTranscript = "";
  /** Generation epoch mirror (independent of the conversation runtime's own gate). */
  private acceptedGeneration = 0;
  private currentGeneration = 0;
  readonly stats = { staleDrops: 0 };

  constructor(provider: AvatarProvider, private readonly opts: AvatarRuntimeOptions = {}) {
    this.provider = provider;
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.machine = new AvatarStateMachine(this.clock);
    this.machine.onTransition((t) => {
      this.provider.setState(t.to);
      if (t.to === "LISTENING") this.opts.latency?.mark("avatar_listening", t.at);
      for (const l of this.stateListeners) l(t);
    });
  }

  get state(): AvatarState {
    return this.machine.state;
  }

  get avatar(): AvatarProvider {
    return this.provider;
  }

  onStateChange(l: (t: StateTransition) => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  /** Swap renderer (Live2D ⇄ VRM ⇄ realistic) without touching the conversation side. */
  async swapProvider(next: AvatarProvider): Promise<void> {
    await this.provider.stop().catch(() => {});
    this.provider = next;
    next.setState(this.machine.state);
  }

  /** Feed the PCM that is actually being played. */
  pushAudio(frame: PCMFrame): void {
    this.provider.pushAudio(frame);
  }

  handleEvent(event: ConversationEvent): void {
    const at = ("at" in event && typeof event.at === "number" ? event.at : undefined) ?? this.clock();
    if (GENERATION_EVENT_TYPES.has(event.type) && "gen" in event && event.gen) {
      if (event.gen.generationId < this.acceptedGeneration) {
        this.stats.staleDrops++;
        return; // late chunk of a cancelled generation: must not re-open the mouth or flip the state
      }
      this.currentGeneration = event.gen.generationId;
    }
    switch (event.type) {
      case "user_speech_started": {
        const wasSpeaking = this.machine.state === "SPEAKING";
        this.machine.dispatch("userSpeechStarted", at);
        if (wasSpeaking) {
          // Mouth closes right now; speaking motion cut (spec §10: ≤100 ms).
          this.bumpGeneration();
          this.provider.interrupt();
          this.opts.latency?.mark("avatar_mouth_closed");
          this.machine.dispatch("userSpeechStarted", at); // INTERRUPTED -> LISTENING
        }
        break;
      }
      case "user_speech_ended":
        this.machine.dispatch("userSpeechEnded", at);
        break;
      case "assistant_thinking":
        this.machine.dispatch("assistantThinking", at);
        break;
      case "assistant_speech_started":
        this.cancelReaction();
        this.machine.dispatch("assistantSpeechStarted", at);
        break;
      case "assistant_audio":
        if (this.machine.state !== "SPEAKING") this.machine.dispatch("assistantSpeechStarted", at);
        break;
      case "assistant_transcript":
        this.lastTranscript = event.text;
        break;
      case "assistant_speech_ended":
        this.provider.interrupt(); // guarantees the mouth is shut even if a frame is in flight
        this.opts.latency?.mark("avatar_mouth_closed");
        this.machine.dispatch("assistantSpeechEnded", at);
        break;
      case "interrupted":
        this.bumpGeneration("gen" in event ? event.gen?.generationId : undefined);
        this.provider.interrupt();
        this.opts.latency?.mark("avatar_mouth_closed");
        if (this.machine.state === "SPEAKING" || this.machine.state === "THINKING") {
          this.machine.dispatch("interrupted", at);
          this.machine.dispatch("userSpeechStarted", at); // -> LISTENING
        }
        break;
      case "session_closed":
        this.cancelReaction();
        this.machine.dispatch("reset", at);
        break;
      default:
        break;
    }
  }

  /** Everything below `cancelled + 1` (or the current generation + 1) is stale from now on. */
  private bumpGeneration(cancelled?: number): void {
    const next = (cancelled ?? this.currentGeneration) + 1;
    if (next > this.acceptedGeneration) this.acceptedGeneration = next;
  }

  get generation(): { accepted: number; current: number } {
    return { accepted: this.acceptedGeneration, current: this.currentGeneration };
  }

  /** A short reaction burst (nod, surprise…) that returns to the previous state. */
  react(gesture: Gesture, intensity = 0.6, emotion?: Emotion, emotionIntensity = 0.5): void {
    this.provider.performGesture(gesture, intensity);
    if (emotion) this.provider.setEmotion(emotion, emotionIntensity);
    if (this.machine.state === "IDLE" || this.machine.state === "REACTING") {
      this.machine.dispatch("reactionStarted");
      this.cancelReaction();
      this.reactionTimer = setTimeout(() => {
        this.reactionTimer = null;
        this.machine.dispatch("reactionEnded");
      }, this.opts.reactionMs ?? 1200);
    }
  }

  setEmotion(emotion: Emotion, intensity: number): void {
    this.provider.setEmotion(emotion, intensity);
  }

  setGaze(target: GazeTarget): void {
    this.provider.setGaze(target);
  }

  getLastTranscript(): string {
    return this.lastTranscript;
  }

  private cancelReaction(): void {
    if (this.reactionTimer) {
      clearTimeout(this.reactionTimer);
      this.reactionTimer = null;
      if (this.machine.state === "REACTING") this.machine.dispatch("reactionEnded");
    }
  }

  async dispose(): Promise<void> {
    this.cancelReaction();
    await this.provider.stop();
  }
}
