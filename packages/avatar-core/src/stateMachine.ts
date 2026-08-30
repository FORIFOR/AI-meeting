import type { AvatarState } from "./types.js";

export type AvatarStateEvent =
  | "userSpeechStarted"
  | "userSpeechEnded"
  | "assistantThinking"
  | "assistantSpeechStarted"
  | "assistantSpeechEnded"
  | "interrupted"
  | "reactionStarted"
  | "reactionEnded"
  | "reset";

export interface StateTransition {
  from: AvatarState;
  to: AvatarState;
  event: AvatarStateEvent;
  at: number;
}

type Listener = (t: StateTransition) => void;

/**
 * Spec §10 state machine.
 * IDLE → LISTENING → THINKING → SPEAKING → IDLE ; SPEAKING → INTERRUPTED → LISTENING.
 * Unknown combinations degrade gracefully (never throw at runtime).
 */
export class AvatarStateMachine {
  private _state: AvatarState = "IDLE";
  private listeners = new Set<Listener>();
  private history: StateTransition[] = [];
  /** State to return to after a REACTING burst. */
  private resumeState: AvatarState = "IDLE";

  constructor(private readonly clock: () => number = () => Date.now()) {}

  get state(): AvatarState {
    return this._state;
  }

  onTransition(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  getHistory(): StateTransition[] {
    return [...this.history];
  }

  /** Returns the resulting state (may equal current). */
  dispatch(event: AvatarStateEvent, at: number = this.clock()): AvatarState {
    const from = this._state;
    const to = next(from, event);
    if (event === "reactionStarted" && from !== "REACTING") this.resumeState = from;
    let target = to;
    if (event === "reactionEnded" && from === "REACTING") target = this.resumeState;
    if (target !== from) {
      this._state = target;
      const t: StateTransition = { from, to: target, event, at };
      this.history.push(t);
      if (this.history.length > 200) this.history.shift();
      for (const l of this.listeners) l(t);
    }
    return this._state;
  }
}

function next(from: AvatarState, event: AvatarStateEvent): AvatarState {
  switch (event) {
    case "reset":
      return "IDLE";
    case "userSpeechStarted":
      // From SPEAKING this is an interruption: go through INTERRUPTED; the runtime immediately follows with LISTENING.
      return from === "SPEAKING" ? "INTERRUPTED" : "LISTENING";
    case "userSpeechEnded":
      return from === "LISTENING" || from === "INTERRUPTED" ? "THINKING" : from;
    case "assistantThinking":
      return from === "SPEAKING" ? from : "THINKING";
    case "assistantSpeechStarted":
      return "SPEAKING";
    case "assistantSpeechEnded":
      return from === "SPEAKING" ? "IDLE" : from;
    case "interrupted":
      return from === "SPEAKING" || from === "THINKING" ? "INTERRUPTED" : from;
    case "reactionStarted":
      return from === "SPEAKING" ? from : "REACTING";
    case "reactionEnded":
      return from === "REACTING" ? "IDLE" : from;
  }
}
