import { describe, expect, it } from "vitest";
import { createProviderRouter, resolveRouting } from "./router.js";
import { PrivacyViolationError, privacyGuard } from "./provider.js";

describe("resolveRouting", () => {
  it("explicit engine routes every role to that provider", () => {
    expect(resolveRouting({ engine: "google", privacyMode: "default" })).toEqual({
      conversation: "google", vision: "google", transcription: "google", evaluation: "google",
    });
  });
  it("auto + privacy_first is fully local", () => {
    expect(resolveRouting({ engine: "auto", autoPolicy: "privacy_first", privacyMode: "default" })).toEqual({
      conversation: "local", vision: "local", transcription: "local", evaluation: "local",
    });
  });
  it("advanced overrides win over policy", () => {
    const d = resolveRouting({ engine: "openai", advanced: { vision: "google", transcription: "local" }, privacyMode: "default" });
    expect(d).toEqual({ conversation: "openai", vision: "google", transcription: "local", evaluation: "openai" });
  });
  it("strict_local forces local and rejects explicit cloud overrides", () => {
    expect(resolveRouting({ engine: "openai", privacyMode: "strict_local" }).conversation).toBe("local");
    expect(() => resolveRouting({ engine: "auto", advanced: { evaluation: "openai" }, privacyMode: "strict_local" })).toThrow(PrivacyViolationError);
  });
  it("falls back to available providers", () => {
    const d = resolveRouting({ engine: "openai", privacyMode: "default", available: ["local", "google"] });
    expect(d.conversation).toBe("google");
    expect(d.transcription).toBe("local");
  });
});

describe("createProviderRouter", () => {
  it("resolves factories and can be reconfigured", () => {
    const router = createProviderRouter(
      {
        conversation: { openai: () => ({ id: "openai" }) as never, local: () => ({ id: "local" }) as never },
        evaluation: { local: () => ({ id: "local" }) as never },
      },
      { engine: "openai", advanced: { evaluation: "local" }, privacyMode: "default" },
    );
    expect(router.conversation().id).toBe("openai");
    expect(router.evaluator().id).toBe("local");
    router.reconfigure({ engine: "local", privacyMode: "strict_local" });
    expect(router.conversation().id).toBe("local");
    expect(() => router.vision()).toThrow(/No vision provider/);
  });
});

describe("privacyGuard", () => {
  it("strips body-like fields from telemetry in strict mode", () => {
    const out = privacyGuard.sanitizeTelemetry("strict_local", { providerId: "local", transcript: "hello world", latencyMs: 300 });
    expect(out).toEqual({ providerId: "local", latencyMs: 300 });
    expect(() => privacyGuard.assert("strict_local", "cloud_tts")).toThrow(PrivacyViolationError);
    expect(privacyGuard.isAllowed("default", "cloud_tts")).toBe(true);
  });
});
