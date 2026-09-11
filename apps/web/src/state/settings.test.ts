import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, chosenAvatarQuality, chosenVoice, decide, loadSettings, saveSettings, settingsForBotPage, settingsReducer } from "./settings.js";

describe("OSS profile", () => {
  it("starts offline with VRM and isolates saved settings from the hosted app", async () => {
    vi.stubEnv("VITE_RCAI_OSS", "true");
    vi.resetModules();
    try {
      const oss = await import("./settings.js");
      expect(oss.DEFAULT_SETTINGS).toMatchObject({ privacyMode: "strict_local", engine: "local", autoPolicy: "offline", characterId: "vroid-b" });
      const normalSaved = JSON.stringify({ engine: "google", privacyMode: "default", characterId: "yui", avatarQuality: { yui: "natural" } });
      const entries = new Map<string, string>([["rcai.settings.v1", normalSaved]]);
      const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
      const loaded = oss.loadSettings(storage);
      expect(loaded).toEqual(oss.DEFAULT_SETTINGS);
      oss.saveSettings(loaded, storage);
      expect(entries.get("rcai.settings.v1")).toBe(normalSaved);
      expect(JSON.parse(entries.get("rcai.settings.oss.v1")!)).toEqual(oss.DEFAULT_SETTINGS);
      const savedNatural = { ...loaded, privacyMode: "default" as const, avatarQuality: { "vroid-b": "natural" as const } };
      expect(oss.chosenAvatarQuality(savedNatural, "vroid-b")).toBe("lightweight");
      expect(oss.settingsReducer(savedNatural, { type: "avatarQuality", characterId: "vroid-b", quality: "natural" })).toBe(savedNatural);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it("preserves the ordinary app's defaults and settings namespace", () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ privacyMode: "default", autoPolicy: "quality_first", characterId: "" });
    const storage = { setItem: vi.fn() };
    saveSettings(DEFAULT_SETTINGS, storage);
    expect(storage.setItem).toHaveBeenCalledWith("rcai.settings.v1", expect.any(String));
  });
});

describe("a page running inside a meeting bot", () => {
  it("routes with the engine the bot was created with, not its own empty settings", () => {
    // Observed in-call: the page kept "auto", picked OpenAI, and the account had no credit — the
    // character rendered and never spoke (429).
    expect(decide(DEFAULT_SETTINGS).conversation).toBe("openai");
    expect(decide(settingsForBotPage(DEFAULT_SETTINGS, "google")).conversation).toBe("google");
    expect(decide(settingsForBotPage(DEFAULT_SETTINGS, "local")).conversation).toBe("local");
  });
  it("ignores an engine it does not know rather than trusting the URL", () => {
    expect(settingsForBotPage(DEFAULT_SETTINGS, "sonnet")).toEqual(DEFAULT_SETTINGS);
    expect(settingsForBotPage(DEFAULT_SETTINGS, undefined)).toEqual(DEFAULT_SETTINGS);
  });
});

describe("voice choice", () => {
  it("is kept per character and per provider — the ids live in different namespaces", () => {
    let s = settingsReducer(DEFAULT_SETTINGS, { type: "voice", characterId: "yui", providerId: "openai", voiceId: "cedar" });
    s = settingsReducer(s, { type: "voice", characterId: "yui", providerId: "google", voiceId: "Aoede" });
    s = settingsReducer(s, { type: "voice", characterId: "haru", providerId: "openai", voiceId: "sage" });
    expect(chosenVoice(s, "yui", "openai")).toBe("cedar");
    expect(chosenVoice(s, "yui", "google")).toBe("Aoede");
    expect(chosenVoice(s, "haru", "openai")).toBe("sage");
    expect(chosenVoice(s, "kei", "openai")).toBeUndefined();
  });
  it("clears back to the character's own voice", () => {
    let s = settingsReducer(DEFAULT_SETTINGS, { type: "voice", characterId: "yui", providerId: "openai", voiceId: "cedar" });
    s = settingsReducer(s, { type: "voice", characterId: "yui", providerId: "openai", voiceId: undefined });
    expect(chosenVoice(s, "yui", "openai")).toBeUndefined();
  });
});

describe("avatar display quality", () => {
  it("defaults existing settings and unconfigured characters to lightweight", () => {
    expect(chosenAvatarQuality(DEFAULT_SETTINGS, "yui")).toBe("lightweight");
    expect(chosenAvatarQuality(DEFAULT_SETTINGS, undefined)).toBe("lightweight");
  });

  it("stores a choice per character without changing voice or conversation routing", () => {
    const before = settingsReducer(DEFAULT_SETTINGS, { type: "voice", characterId: "yui", providerId: "google", voiceId: "Aoede" });
    let settings = settingsReducer(before, { type: "avatarQuality", characterId: "yui", quality: "natural" });
    settings = settingsReducer(settings, { type: "avatarQuality", characterId: "haru", quality: "lightweight" });
    expect(chosenAvatarQuality(settings, "yui")).toBe("natural");
    expect(chosenAvatarQuality(settings, "haru")).toBe("lightweight");
    expect(chosenAvatarQuality(settings, "kei")).toBe("lightweight");
    expect(settings.voices).toBe(before.voices);
    expect(chosenVoice(settings, "yui", "google")).toBe("Aoede");
    expect(decide(settings)).toEqual(decide(before));
  });

  it("forces lightweight in strict local mode while retaining the previous preference", () => {
    const natural = settingsReducer(DEFAULT_SETTINGS, { type: "avatarQuality", characterId: "yui", quality: "natural" });
    const strict = settingsReducer(natural, { type: "privacy", mode: "strict_local" });
    expect(chosenAvatarQuality(strict, "yui")).toBe("lightweight");
    expect(settingsReducer(strict, { type: "avatarQuality", characterId: "haru", quality: "natural" })).toBe(strict);
    expect(chosenAvatarQuality(settingsReducer(strict, { type: "privacy", mode: "default" }), "yui")).toBe("natural");
  });

  it("persists valid display choices and drops unknown stored values", () => {
    let saved = "";
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    saveSettings(settingsReducer(DEFAULT_SETTINGS, { type: "avatarQuality", characterId: "yui", quality: "natural" }), storage);
    expect(chosenAvatarQuality(loadSettings(storage), "yui")).toBe("natural");
    saved = JSON.stringify({ avatarQuality: { yui: "natural", haru: "lightweight", kei: "cinematic", sora: true, broken: { quality: "natural" }, "": "natural" } });
    expect(loadSettings(storage).avatarQuality).toEqual({ yui: "natural", haru: "lightweight" });
  });

  it.each([null, "natural", 1, ["natural"]])("ignores malformed display preferences: %j", (avatarQuality) => {
    const settings = loadSettings({ getItem: () => JSON.stringify({ avatarQuality }) });
    expect(settings.avatarQuality).toBeUndefined();
    expect(chosenAvatarQuality(settings, "yui")).toBe("lightweight");
  });
});

describe("settingsReducer", () => {
  it("switches engine and advanced overrides", () => {
    let s = settingsReducer(DEFAULT_SETTINGS, { type: "engine", engine: "google" });
    s = settingsReducer(s, { type: "advanced", role: "transcription", provider: "local" });
    expect(decide(s)).toEqual({ conversation: "google", vision: "google", transcription: "local", evaluation: "google" });
    s = settingsReducer(s, { type: "advanced", role: "transcription", provider: undefined });
    expect(decide(s).transcription).toBe("google");
  });
  it("strict_local forces everything local and rejects cloud choices", () => {
    let s = settingsReducer(DEFAULT_SETTINGS, { type: "engine", engine: "openai" });
    s = settingsReducer(s, { type: "privacy", mode: "strict_local" });
    expect(s.engine).toBe("local");
    expect(decide(s)).toEqual({ conversation: "local", vision: "local", transcription: "local", evaluation: "local" });
    s = settingsReducer(s, { type: "engine", engine: "openai" });
    expect(s.engine).toBe("local");
    s = settingsReducer(s, { type: "advanced", role: "evaluation", provider: "openai" });
    expect(s.advanced.evaluation).toBeUndefined();
  });
  it("auto policy honours availability", () => {
    const s = settingsReducer(DEFAULT_SETTINGS, { type: "autoPolicy", policy: "quality_first" });
    expect(decide(s, { openai: false, google: true, local: true }).conversation).toBe("google");
    expect(decide(s, { openai: false, google: false, local: true }).conversation).toBe("local");
  });
  it("persists without secrets", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    saveSettings({ ...DEFAULT_SETTINGS, brokerUrl: "http://x:1" }, storage);
    store.set("rcai.settings.v1", JSON.stringify({ ...JSON.parse(store.get("rcai.settings.v1")!), apiKey: "sk-nope" }));
    const loaded = loadSettings(storage) as unknown as Record<string, unknown>;
    expect(loaded.brokerUrl).toBe("http://x:1");
    expect(loaded.apiKey).toBeUndefined();
  });
});
