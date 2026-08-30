/**
 * The ONLY file that touches sibling integration packages. Everything is loaded lazily and
 * typed against the @rcai/*-core contracts, so the app typechecks/builds even while a sibling
 * package is still a placeholder. A missing export becomes a readable BLOCKED_BY_* error.
 */
import type { PrivacyMode, ProviderId } from "@rcai/conversation-core";
import type { EvaluationProvider, RealtimeAIProvider } from "@rcai/provider-core";
import type { AvatarProvider, CharacterManifest } from "@rcai/avatar-core";
import type { Persona } from "@rcai/persona-core";
import { agentHttpUrl } from "../api/health.js";

export class IntegrationMissingError extends Error {
  constructor(readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "IntegrationMissingError";
  }
}

type Ctor<T, O> = new (opts: O) => T;

function pick<T>(mod: unknown, name: string, code: string): T {
  const v = (mod as Record<string, unknown> | null)?.[name];
  if (v === undefined) throw new IntegrationMissingError(code, `export "${name}" not found (package not implemented yet)`);
  return v as T;
}

// ---- conversation providers ------------------------------------------------

export interface ProviderFactoryOptions {
  brokerUrl: string;
  agentUrl: string;
  privacyMode: PrivacyMode;
  model?: string;
}

export async function createConversationProvider(id: ProviderId, o: ProviderFactoryOptions): Promise<RealtimeAIProvider> {
  switch (id) {
    case "openai": {
      const mod = await import("@rcai/provider-openai");
      const C = pick<Ctor<RealtimeAIProvider, { brokerUrl: string; model?: string }>>(mod, "OpenAIRealtimeProvider", "BLOCKED_BY_PROVIDER_OPENAI");
      return new C({ brokerUrl: o.brokerUrl, model: o.model });
    }
    case "google": {
      const mod = await import("@rcai/provider-gemini");
      const C = pick<Ctor<RealtimeAIProvider, { brokerUrl: string; model?: string }>>(mod, "GeminiLiveProvider", "BLOCKED_BY_PROVIDER_GEMINI");
      return new C({ brokerUrl: o.brokerUrl, model: o.model });
    }
    case "local": {
      const mod = await import("@rcai/provider-local");
      const C = pick<Ctor<RealtimeAIProvider, { agentUrl: string }>>(mod, "LocalProvider", "BLOCKED_BY_PROVIDER_LOCAL");
      return new C({ agentUrl: o.agentUrl });
    }
  }
}

// ---- evaluation ------------------------------------------------------------

export async function createEvaluator(id: ProviderId, o: ProviderFactoryOptions): Promise<EvaluationProvider> {
  switch (id) {
    case "openai": {
      const mod = await import("@rcai/provider-openai");
      const f = pick<(opts: { brokerUrl: string }) => EvaluationProvider>(mod, "createOpenAIEvaluationProvider", "BLOCKED_BY_PROVIDER_OPENAI");
      return f({ brokerUrl: o.brokerUrl });
    }
    case "google": {
      const mod = await import("@rcai/provider-gemini");
      const f = pick<(opts: { brokerUrl: string }) => EvaluationProvider>(mod, "createGeminiEvaluationProvider", "BLOCKED_BY_PROVIDER_GEMINI");
      return f({ brokerUrl: o.brokerUrl });
    }
    case "local": {
      const mod = await import("@rcai/provider-local");
      const f = pick<(opts: { agentUrl: string }) => EvaluationProvider>(mod, "createLocalEvaluationProvider", "BLOCKED_BY_PROVIDER_LOCAL");
      return f({ agentUrl: o.agentUrl });
    }
  }
}

/** Offline heuristic evaluator from services/evaluation — used as the last-resort fallback. */
export async function createHeuristicEvaluator(): Promise<EvaluationProvider> {
  const mod = await import("@rcai/evaluation");
  const C = pick<new () => EvaluationProvider>(mod, "HeuristicEvaluator", "BLOCKED_BY_EVALUATION_PKG");
  return new C();
}

// ---- avatars ------------------------------------------------------------------

export type Renderer = CharacterManifest["renderer"];

export interface AvatarFactoryOptions {
  container: HTMLElement;
  brokerUrl: string;
  privacyMode?: "default" | "strict_local";
}

export async function createAvatarProvider(renderer: Renderer, o: AvatarFactoryOptions): Promise<AvatarProvider> {
  const strict = o.privacyMode === "strict_local";
  if (strict && (renderer === "liveavatar" || renderer === "tavus")) throw new Error("BLOCKED_BY_STRICT_LOCAL: cloud avatars are disabled under strict_local");
  switch (renderer) {
    case "live2d": {
      const mod = await import("@rcai/avatar-live2d");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement; allowCdn?: boolean }>>(mod, "Live2DAvatarProvider", "BLOCKED_BY_AVATAR_LIVE2D");
      return new C({ container: o.container, allowCdn: !strict });
    }
    case "canvas": {
      const mod = await import("@rcai/avatar-canvas");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement }>>(mod, "CanvasAvatarProvider", "BLOCKED_BY_AVATAR_CANVAS");
      return new C({ container: o.container });
    }
    case "vrm": {
      const mod = await import("@rcai/avatar-vrm");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement }>>(mod, "VRMAvatarProvider", "BLOCKED_BY_AVATAR_VRM");
      return new C({ container: o.container });
    }
    case "liveavatar": {
      const mod = await import("@rcai/avatar-liveavatar");
      const C = pick<Ctor<AvatarProvider, { brokerUrl: string; container: HTMLElement }>>(mod, "LiveAvatarProvider", "BLOCKED_BY_AVATAR_LIVEAVATAR");
      return new C({ brokerUrl: o.brokerUrl, container: o.container });
    }
    case "tavus": {
      const mod = await import("@rcai/avatar-tavus");
      const C = pick<Ctor<AvatarProvider, { brokerUrl: string; container: HTMLElement }>>(mod, "TavusAvatarProvider", "BLOCKED_BY_AVATAR_TAVUS");
      return new C({ brokerUrl: o.brokerUrl, container: o.container });
    }
  }
}

// ---- content -------------------------------------------------------------------

export interface CharacterEntry {
  id: string;
  name: string;
  renderer: Renderer;
  baseUrl: string;
  license?: string;
  defaultPersona?: string;
}

export async function loadCharacterEntries(): Promise<{ entries: CharacterEntry[]; error?: string }> {
  try {
    const mod = await import("@rcai/characters");
    const list = pick<CharacterEntry[]>(mod, "characters", "BLOCKED_BY_CHARACTERS_PKG");
    return { entries: list };
  } catch (e) {
    return { entries: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadPersonas(): Promise<{ personas: Persona[]; error?: string }> {
  try {
    const mod = await import("@rcai/personas");
    const list = pick<Persona[]>(mod, "personas", "BLOCKED_BY_PERSONAS_PKG");
    return { personas: list };
  } catch (e) {
    return { personas: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Where the semantic planner lives for this routing (spec §15): agent for local/strict, broker otherwise. */
export function plannerUrl(conversation: ProviderId, o: { brokerUrl: string; agentUrl: string; privacyMode: PrivacyMode }): string {
  if (o.privacyMode === "strict_local" || conversation === "local") return `${agentHttpUrl(o.agentUrl)}/plan`;
  return `${o.brokerUrl.replace(/\/$/, "")}/api/plan`;
}

// ---- meeting connectors (P0-1) -----------------------------------------------------------------

export type MeetingConnectorLike = import("@rcai/meeting-core").MeetingConnector;

export interface MeetingFactoryOptions {
  brokerUrl: string;
  privacyMode: PrivacyMode;
  /** output_media (bot streams our page) or relay (events relayed to this browser). */
  mode?: "output_media" | "relay";
  botPageQuery?: Record<string, string>;
}

/** Only Recall is implemented today; zoom_native / google_native are reserved ids on the contract. */
export async function createMeetingConnector(id: "recall" | "zoom_native" | "google_native", o: MeetingFactoryOptions): Promise<MeetingConnectorLike> {
  if (o.privacyMode === "strict_local") throw new Error("BLOCKED_BY_STRICT_LOCAL: meeting connectors send audio to a cloud meeting service");
  switch (id) {
    case "recall": {
      const mod = await import("@rcai/connector-recall");
      const C = pick<Ctor<MeetingConnectorLike, { brokerUrl: string; mode?: "output_media" | "relay"; botPageQuery?: Record<string, string> }>>(mod, "RecallConnector", "BLOCKED_BY_CONNECTOR_RECALL");
      return new C({ brokerUrl: o.brokerUrl, mode: o.mode, botPageQuery: o.botPageQuery });
    }
    default:
      throw new Error(`BLOCKED_BY_CONNECTOR_${id.toUpperCase()}: not implemented`);
  }
}
