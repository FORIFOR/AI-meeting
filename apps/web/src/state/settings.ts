import type { PrivacyMode, ProviderId } from "@rcai/conversation-core";
import { resolveRouting, type AutoPolicy, type EngineSelection, type Role, type RouterConfig, type RoutingDecision } from "@rcai/provider-core";

export interface Settings {
  brokerUrl: string;
  agentUrl: string;
  engine: EngineSelection;
  autoPolicy: AutoPolicy;
  advanced: Partial<Record<Role, ProviderId>>;
  privacyMode: PrivacyMode;
  showHud: boolean;
  characterId: string;
  cameraOn: boolean;
  /** Optional explicit audio devices (acoustic gate / multi-device setups). */
  inputDeviceId?: string;
  outputDeviceId?: string;
  captionsOn: boolean;
  /**
   * Chosen voice per character and provider, keyed "characterId:providerId".
   * The voice ids belong to different namespaces per provider, and the same character
   * reads as a different person in each, so the choice is stored per pair rather than globally.
   * Absent means "use the character's own voice".
   */
  voices: Record<string, string>;
  /**
   * Prefer reacting to tone and expression over the lowest latency. Gemini's native-audio models are
   * the only ones with affective dialog and proactive audio, and they are slower than flash-live —
   * which is why this is a choice and not the default.
   */
  expressive: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  brokerUrl: import.meta.env.VITE_RCAI_CLOUD === "true" ? (import.meta.env.VITE_RCAI_BROKER_URL ?? window.location.origin) : "http://localhost:8787",
  agentUrl: import.meta.env.VITE_RCAI_CLOUD === "true" ? (import.meta.env.VITE_RCAI_AGENT_URL ?? `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/agent`) : "ws://localhost:8788",
  engine: import.meta.env.VITE_RCAI_CLOUD === "true" ? "google" : "auto",
  autoPolicy: "quality_first",
  advanced: {},
  privacyMode: "default",
  showHud: false,
  characterId: "",
  cameraOn: false,
  captionsOn: true,
  voices: {},
  expressive: false,
};

export type SettingsAction =
  | { type: "engine"; engine: EngineSelection }
  | { type: "autoPolicy"; policy: AutoPolicy }
  | { type: "advanced"; role: Role; provider: ProviderId | undefined }
  | { type: "privacy"; mode: PrivacyMode }
  | { type: "hud"; on: boolean }
  | { type: "character"; id: string }
  | { type: "urls"; brokerUrl?: string; agentUrl?: string }
  | { type: "camera"; on: boolean }
  | { type: "captions"; on: boolean }
  | { type: "voice"; characterId: string; providerId: ProviderId; voiceId: string | undefined }
  | { type: "expressive"; on: boolean }
  | { type: "reset" };

/** strict_local (spec §6) forces the local engine and clears cloud overrides. */
export function settingsReducer(s: Settings, a: SettingsAction): Settings {
  switch (a.type) {
    case "engine":
      if (s.privacyMode === "strict_local" && a.engine !== "local") return s;
      return { ...s, engine: a.engine };
    case "autoPolicy":
      return { ...s, autoPolicy: a.policy };
    case "advanced": {
      if (s.privacyMode === "strict_local" && a.provider && a.provider !== "local") return s;
      const advanced = { ...s.advanced };
      if (a.provider) advanced[a.role] = a.provider;
      else delete advanced[a.role];
      return { ...s, advanced };
    }
    case "privacy":
      if (a.mode === "strict_local") return { ...s, privacyMode: a.mode, engine: "local", autoPolicy: "offline", advanced: {} };
      return { ...s, privacyMode: a.mode };
    case "hud":
      return { ...s, showHud: a.on };
    case "character":
      return { ...s, characterId: a.id };
    case "urls":
      return { ...s, brokerUrl: a.brokerUrl ?? s.brokerUrl, agentUrl: a.agentUrl ?? s.agentUrl };
    case "camera":
      return { ...s, cameraOn: a.on };
    case "captions":
      return { ...s, captionsOn: a.on };
    case "expressive":
      return { ...s, expressive: a.on };
    case "voice": {
      const voices = { ...s.voices };
      if (a.voiceId) voices[voiceKey(a.characterId, a.providerId)] = a.voiceId;
      else delete voices[voiceKey(a.characterId, a.providerId)];
      return { ...s, voices };
    }
    case "reset":
      return { ...DEFAULT_SETTINGS };
  }
}

export function voiceKey(characterId: string, providerId: ProviderId): string {
  return `${characterId}:${providerId}`;
}

/** The voice the user chose for this character on this provider, if any. */
export function chosenVoice(s: Settings, characterId: string | undefined, providerId: ProviderId): string | undefined {
  if (!characterId) return undefined;
  return s.voices?.[voiceKey(characterId, providerId)];
}

/**
 * Settings for a page running inside a meeting bot.
 *
 * The engine chosen when the bot was created travels in the bot-page URL. The page has its own empty
 * storage, so routing by its own settings means "auto" — which prefers a cloud engine, and an account
 * with no credit renders the character and never speaks (observed in-call: OpenAI 429, silent bot).
 * An engine the app does not know is ignored rather than trusted.
 */
export function settingsForBotPage(base: Settings, engine: string | undefined): Settings {
  const known: EngineSelection[] = ["auto", "openai", "google", "local"];
  return engine && known.includes(engine as EngineSelection) ? { ...base, engine: engine as EngineSelection } : base;
}

export interface Availability {
  openai: boolean;
  google: boolean;
  local: boolean;
}

export function routerConfigFor(s: Settings, avail?: Availability): RouterConfig {
  const available: ProviderId[] | undefined = avail
    ? (["openai", "google", "local"] as ProviderId[]).filter((p) => avail[p === "google" ? "google" : p === "openai" ? "openai" : "local"])
    : undefined;
  return {
    engine: s.engine,
    autoPolicy: s.autoPolicy,
    advanced: s.advanced,
    privacyMode: s.privacyMode,
    available: available && available.length ? available : undefined,
  };
}

export function decide(s: Settings, avail?: Availability): RoutingDecision {
  return resolveRouting(routerConfigFor(s, avail));
}

const KEY = "rcai.settings.v1";
/** Keys that must never be persisted (spec §26: no secrets in the client). */
const FORBIDDEN = /key|secret|token/i;

export function loadSettings(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const clean: Partial<Settings> = {};
    for (const [k, v] of Object.entries(parsed)) if (!FORBIDDEN.test(k)) (clean as Record<string, unknown>)[k] = v;
    return { ...DEFAULT_SETTINGS, ...clean, advanced: { ...(clean.advanced ?? {}) }, voices: { ...(clean.voices ?? {}) } };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings, storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode */
  }
}

export const PROVIDER_LABEL: Record<ProviderId, string> = { openai: "OpenAI", google: "Google Gemini", local: "Local" };
export const POLICY_LABEL: Record<AutoPolicy, { ja: string; en: string }> = {
  quality_first: { ja: "品質優先", en: "Quality First" },
  privacy_first: { ja: "プライバシー優先", en: "Privacy First" },
  low_latency: { ja: "低遅延", en: "Low Latency" },
  low_cost: { ja: "低コスト", en: "Low Cost" },
  offline: { ja: "オフライン", en: "Offline" },
};
export const ROLE_LABEL: Record<Role, { ja: string; en: string }> = {
  conversation: { ja: "会話", en: "Conversation" },
  vision: { ja: "視覚", en: "Vision" },
  transcription: { ja: "文字起こし", en: "STT" },
  evaluation: { ja: "評価", en: "Evaluation" },
};
