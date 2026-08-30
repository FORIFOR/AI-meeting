import type { ConversationMode } from "@rcai/conversation-core";

export interface SpeakingStyle {
  speed: "slow" | "normal" | "fast";
  /** 0..1 */
  energy: number;
  politeness: "casual" | "polite" | "formal";
  sentenceLength: "short" | "medium";
  /** Free-form voice direction shared across providers (spec §24). */
  tone?: string;
}

export interface TurnPolicy {
  maxSentences: number;
  /** How long the assistant tolerates silence before gently prompting (ms). */
  allowSilenceMs: number;
  backchannel: boolean;
  interruptible: boolean;
  /** English lesson: never correct every sentence (spec §20). */
  correctionPolicy: "none" | "deferred" | "immediate";
}

export interface PersonaParamSpec {
  key: string;
  label: string;
  type: "select" | "text";
  options?: string[];
  default?: string;
}

/** Spec §18 */
export interface Persona {
  id: string;
  name: string;
  mode: ConversationMode;
  /** May contain {{param}} placeholders filled from mode params. */
  systemPrompt: string;
  language: string;
  speakingStyle: SpeakingStyle;
  turnPolicy: TurnPolicy;
  motionProfile: string;
  evaluationProfile?: string;
  /** UI-configurable parameters for the start screen (position, company style, difficulty …). */
  params?: PersonaParamSpec[];
  /** First line the assistant says when the session starts (optional). */
  opening?: string;
  /** Emotion bias hint for the behavior engine. */
  defaultEmotion?: string;
}

export class PersonaValidationError extends Error {}

const MODES: ConversationMode[] = ["free_talk", "interview", "english_lesson", "sales_roleplay", "tutor", "career"];

export function validatePersona(raw: unknown): Persona {
  const p = raw as Partial<Persona>;
  if (!p || typeof p !== "object") throw new PersonaValidationError("persona must be an object");
  for (const k of ["id", "name", "systemPrompt", "language", "motionProfile"] as const) {
    if (typeof p[k] !== "string" || !p[k]) throw new PersonaValidationError(`persona.${k} required`);
  }
  if (!MODES.includes(p.mode as ConversationMode)) throw new PersonaValidationError(`persona.mode invalid: ${p.mode}`);
  if (!p.speakingStyle || typeof p.speakingStyle.energy !== "number") throw new PersonaValidationError("persona.speakingStyle required");
  if (!p.turnPolicy || typeof p.turnPolicy.maxSentences !== "number") throw new PersonaValidationError("persona.turnPolicy required");
  return p as Persona;
}

export class PersonaRegistry {
  private personas = new Map<string, Persona>();

  register(persona: Persona): this {
    this.personas.set(persona.id, validatePersona(persona));
    return this;
  }

  get(id: string): Persona {
    const p = this.personas.get(id);
    if (!p) throw new PersonaValidationError(`unknown persona ${id}`);
    return p;
  }

  list(mode?: ConversationMode): Persona[] {
    return [...this.personas.values()].filter((p) => !mode || p.mode === mode);
  }
}
