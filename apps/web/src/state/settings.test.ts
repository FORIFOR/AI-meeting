import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, decide, loadSettings, saveSettings, settingsReducer } from "./settings.js";

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
