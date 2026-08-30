import type { PrivacyMode, ProviderId } from "@rcai/conversation-core";
import type { EvaluationProvider, RealtimeAIProvider, STTProvider, VisionProvider } from "./provider.js";
import { PrivacyViolationError } from "./provider.js";

/** Spec §7 */
export type EngineSelection = "auto" | ProviderId;
export type AutoPolicy = "quality_first" | "privacy_first" | "low_latency" | "low_cost" | "offline";
export type Role = "conversation" | "vision" | "transcription" | "evaluation";

export interface RouterConfig {
  engine: EngineSelection;
  autoPolicy?: AutoPolicy;
  /** Advanced per-role overrides ("Conversation OpenAI / Vision Gemini / STT Local ..."). */
  advanced?: Partial<Record<Role, ProviderId>>;
  privacyMode: PrivacyMode;
  /** Providers that are actually usable right now (credentials configured, local runtime online). */
  available?: ProviderId[];
}

export type RoutingDecision = Record<Role, ProviderId>;

const POLICY_TABLE: Record<AutoPolicy, RoutingDecision> = {
  quality_first: { conversation: "openai", vision: "google", transcription: "openai", evaluation: "openai" },
  privacy_first: { conversation: "local", vision: "local", transcription: "local", evaluation: "local" },
  low_latency: { conversation: "openai", vision: "google", transcription: "local", evaluation: "google" },
  low_cost: { conversation: "google", vision: "google", transcription: "local", evaluation: "local" },
  offline: { conversation: "local", vision: "local", transcription: "local", evaluation: "local" },
};

const FALLBACK_ORDER: Record<Role, ProviderId[]> = {
  conversation: ["openai", "google", "local"],
  vision: ["google", "openai", "local"],
  transcription: ["local", "openai", "google"],
  evaluation: ["openai", "google", "local"],
};

/**
 * Pure routing function: config -> which provider serves which role.
 * strict_local forces every role to local and throws if an override asks for cloud.
 */
export function resolveRouting(config: RouterConfig): RoutingDecision {
  const base: RoutingDecision =
    config.engine === "auto"
      ? { ...POLICY_TABLE[config.autoPolicy ?? "quality_first"] }
      : { conversation: config.engine, vision: config.engine, transcription: config.engine, evaluation: config.engine };

  for (const role of Object.keys(base) as Role[]) {
    const override = config.advanced?.[role];
    if (override) base[role] = override;
  }

  if (config.privacyMode === "strict_local") {
    for (const role of Object.keys(base) as Role[]) {
      if (base[role] !== "local") {
        if (config.advanced?.[role] && config.advanced[role] !== "local") {
          throw new PrivacyViolationError(roleToEgress(role));
        }
        base[role] = "local";
      }
    }
    return base;
  }

  if (config.available && config.available.length > 0) {
    const avail = new Set(config.available);
    for (const role of Object.keys(base) as Role[]) {
      if (!avail.has(base[role])) {
        const alt = FALLBACK_ORDER[role].find((p) => avail.has(p));
        if (alt) base[role] = alt;
      }
    }
  }
  return base;
}

function roleToEgress(role: Role) {
  switch (role) {
    case "conversation":
      return "cloud_conversation" as const;
    case "vision":
      return "cloud_vision" as const;
    case "transcription":
      return "cloud_stt" as const;
    case "evaluation":
      return "cloud_evaluator" as const;
  }
}

export interface ProviderRegistry {
  conversation: Partial<Record<ProviderId, () => RealtimeAIProvider>>;
  evaluation: Partial<Record<ProviderId, () => EvaluationProvider>>;
  vision?: Partial<Record<ProviderId, () => VisionProvider>>;
  transcription?: Partial<Record<ProviderId, () => STTProvider>>;
}

/** Spec §7 ProviderRouter */
export interface ProviderRouter {
  conversation(): RealtimeAIProvider;
  evaluator(): EvaluationProvider;
  vision(): VisionProvider;
  transcription(): STTProvider;
  readonly decision: RoutingDecision;
  readonly config: RouterConfig;
  reconfigure(config: RouterConfig): void;
}

export function createProviderRouter(registry: ProviderRegistry, initial: RouterConfig): ProviderRouter {
  let config = initial;
  let decision = resolveRouting(config);
  const pick = <T>(table: Partial<Record<ProviderId, () => T>> | undefined, role: Role): T => {
    const id = decision[role];
    const factory = table?.[id];
    if (!factory) throw new Error(`No ${role} provider registered for "${id}"`);
    return factory();
  };
  return {
    get decision() {
      return decision;
    },
    get config() {
      return config;
    },
    reconfigure(next) {
      config = next;
      decision = resolveRouting(next);
    },
    conversation: () => pick(registry.conversation, "conversation"),
    evaluator: () => pick(registry.evaluation, "evaluation"),
    vision: () => pick(registry.vision, "vision"),
    transcription: () => pick(registry.transcription, "transcription"),
  };
}
