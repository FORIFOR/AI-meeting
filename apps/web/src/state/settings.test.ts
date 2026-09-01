import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, chosenVoice, decide, loadSettings, saveSettings, settingsForBotPage, settingsReducer } from "./settings.js";

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
