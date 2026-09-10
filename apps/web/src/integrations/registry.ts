import { zoomToken } from "../api/zoom.js";
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
  /**
   * Prefer a model that reacts to how something was said, and may choose to say nothing, over the
   * fastest one. Only Gemini's native-audio family has either; everywhere else it is ignored.
   */
  expressive?: boolean;
}

/** The Gemini live model that reacts to tone and can choose to stay quiet. Slower than flash-live. */
export const GEMINI_EXPRESSIVE_MODEL = "gemini-2.5-flash-native-audio-latest";

export async function createConversationProvider(id: ProviderId, o: ProviderFactoryOptions): Promise<RealtimeAIProvider> {
  switch (id) {
    case "openai": {
      const mod = await import("@rcai/provider-openai");
      const C = pick<Ctor<RealtimeAIProvider, { brokerUrl: string; model?: string; turnDetection?: "server_vad" | "semantic_vad" }>>(mod, "OpenAIRealtimeProvider", "BLOCKED_BY_PROVIDER_OPENAI");
      /**
       * Semantic VAD estimates whether an utterance *finished*, rather than whether sound stopped —
       * the same question Smart Turn answers locally. In a meeting our own answer is authoritative,
       * because it is per speaker and OpenAI hears one mixed stream, but asking for the better
       * estimate costs nothing where the two agree.
       */
      return new C({ brokerUrl: o.brokerUrl, model: o.model, turnDetection: o.expressive ? "semantic_vad" : undefined });
    }
    case "google": {
      const mod = await import("@rcai/provider-gemini");
      const C = pick<Ctor<RealtimeAIProvider, { brokerUrl: string; model?: string; proactiveAudio?: boolean; enableAffectiveDialog?: boolean }>>(mod, "GeminiLiveProvider", "BLOCKED_BY_PROVIDER_GEMINI");
      /**
       * Two live families, one real trade-off. The flash-live models answer faster; only the
       * native-audio ones take affective dialog (responding to *how* something was said) and proactive
       * audio (the model deciding that the right response is none). Asking for the second is asking to
       * be slower, so it is a choice rather than a default.
       */
      const affective = o.expressive === true;
      const model = o.model ?? (affective ? GEMINI_EXPRESSIVE_MODEL : undefined);
      /**
       * `enableAffectiveDialog` is left undefined rather than false when the setting is off, so the
       * provider's own rule applies: on for the native-audio family, absent everywhere else. Sending
       * `false` was a trap — an operator who pins the native-audio model pays 3–5× the latency for it
       * and would have had the one feature that justifies the cost explicitly switched off.
       * Proactive audio stays opt-in: a model deciding not to answer is a behaviour change, not a
       * quality setting.
       */
      return new C({ brokerUrl: o.brokerUrl, model, proactiveAudio: affective, enableAffectiveDialog: affective ? true : undefined });
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
  /** Character metadata used to make a renderer fallback identifiable in a meeting tile. */
  characterId?: string;
  characterName?: string;
  privacyMode?: "default" | "strict_local";
  /** "meeting": the page is a camera tile, not an operator's screen (see Live2DAvatarOptions.framing). */
  framing?: "default" | "meeting" | "preview";
  /** Cap on the avatar's render frame rate (see Live2DAvatarOptions.maxFps). */
  maxFps?: number;
}

/** Renderers that cannot draw anything without a WebGL context. */
const NEEDS_WEBGL: Renderer[] = ["live2d", "vrm"];

/**
 * Is there a WebGL context to be had in this browser?
 *
 * Not a theoretical question: a meeting vendor runs our page in its own Chrome, and Attendee's webpage
 * streamer launches it with `--disable-gpu` and no `--enable-unsafe-swiftshader`, which in current
 * Chrome means no WebGL at all — measured, both flag sets, in `docs/commercial-gate.md`. Without this
 * check the failure is a blank camera tile and a session that looks fine from every log we keep.
 */
export function webglAvailable(): boolean {
  if (typeof document === "undefined") return true;
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
  } catch {
    return false;
  }
}

export async function createAvatarProvider(renderer: Renderer, o: AvatarFactoryOptions): Promise<AvatarProvider> {
  const strict = o.privacyMode === "strict_local";
  if (strict && (renderer === "liveavatar" || renderer === "tavus")) throw new Error("BLOCKED_BY_STRICT_LOCAL: cloud avatars are disabled under strict_local");
  if (NEEDS_WEBGL.includes(renderer) && !webglAvailable()) {
    /**
     * Attendee and similar meeting page browsers may disable GPU/WebGL. A hard failure here leaves
     * the bot audible but invisible in the participant tile. Live2D has a canonical 2D renderer
     * that uses the same motion parameters, so keep the tile useful and identifiable in that case.
     * VRM remains an explicit error until a 2D equivalent is available for it.
     */
    if (renderer === "live2d") {
      const mod = await import("@rcai/avatar-canvas");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement; accent?: string; label?: string }>>(mod, "CanvasAvatarProvider", "BLOCKED_BY_AVATAR_CANVAS");
      const accents: Record<string, string> = { yui: "#7c6de6", haru: "#5ca8d8", kei: "#d178b0", reina: "#9c7abf" };
      return new C({ container: o.container, accent: (o.characterId && accents[o.characterId]) ?? "#5b5bd6", ...(o.characterName ? { label: o.characterName } : {}) });
    }
    throw new Error(`BLOCKED_BY_NO_WEBGL: ${renderer} needs a WebGL context and this browser has none (a meeting vendor's page browser may run with --disable-gpu)`);
  }
  switch (renderer) {
    case "live2d": {
      const mod = await import("@rcai/avatar-live2d");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement; allowCdn?: boolean; framing?: "default" | "meeting" | "preview"; maxFps?: number }>>(mod, "Live2DAvatarProvider", "BLOCKED_BY_AVATAR_LIVE2D");
      return new C({ container: o.container, allowCdn: !strict, framing: o.framing ?? "default", ...(o.maxFps ? { maxFps: o.maxFps } : {}) });
    }
    case "canvas": {
      const mod = await import("@rcai/avatar-canvas");
      const C = pick<Ctor<AvatarProvider, { container: HTMLElement; accent?: string; label?: string }>>(mod, "CanvasAvatarProvider", "BLOCKED_BY_AVATAR_CANVAS");
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
  /** Alternative spellings the character answers to (Japanese readings of a romaji name). */
  aliases?: string[];
  /** Recogniser mishearings of the name, accepted only as an utterance-initial call (see characters/index.ts). */
  soundalikes?: string[];
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
export async function createMeetingConnector(id: "recall" | "attendee" | "zoom_native" | "google_native", o: MeetingFactoryOptions): Promise<MeetingConnectorLike> {
  if (o.privacyMode === "strict_local") throw new Error("BLOCKED_BY_STRICT_LOCAL: meeting connectors send audio to a cloud meeting service");
  switch (id) {
    case "recall": {
      const mod = await import("@rcai/connector-recall");
      const C = pick<Ctor<MeetingConnectorLike, { brokerUrl: string; mode?: "output_media" | "relay"; botPageQuery?: Record<string, string> }>>(mod, "RecallConnector", "BLOCKED_BY_CONNECTOR_RECALL");
      return new C({ brokerUrl: o.brokerUrl, mode: o.mode, botPageQuery: o.botPageQuery });
    }
    case "attendee": {
      // Same contract, different economics: Attendee streams the character's audio back on the socket it
      // sends on, so there is no clip encoding and no WebGL surcharge to pay for the avatar.
      const mod = await import("@rcai/connector-attendee");
      const C = pick<Ctor<MeetingConnectorLike, { brokerUrl: string; botPageQuery?: Record<string, string>; authToken?: () => string | null }>>(mod, "AttendeeConnector", "BLOCKED_BY_CONNECTOR_ATTENDEE");
      return new C({ brokerUrl: o.brokerUrl, botPageQuery: o.botPageQuery, authToken: () => zoomToken(o.brokerUrl) });
    }
    default:
      throw new Error(`BLOCKED_BY_CONNECTOR_${id.toUpperCase()}: not implemented`);
  }
}
