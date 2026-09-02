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
  it("does not quietly serve an explicit choice from another vendor", () => {
    /**
     * This used to fall back. It cost a meeting: a bot page asked for the local agent, a health probe
     * through a flaky tunnel said local was down, and the router handed it an OpenAI account with no
     * credit — so the character joined, rendered, and never said a word. A different vendor is a
     * different data processor and a different bill; failing by name is the honest outcome.
     */
    const d = resolveRouting({ engine: "openai", privacyMode: "default", available: ["local", "google"] });
    expect(d.conversation).toBe("openai");
    expect(d.transcription).toBe("openai");
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

describe("an explicit choice is an instruction, not a preference", () => {
  it("keeps the chosen engine even when a health probe says it is down", () => {
    const d = resolveRouting({ engine: "local", privacyMode: "default", available: ["openai", "google"] });
    expect(d.conversation).toBe("local");
    expect(d.transcription).toBe("local");
  });

  it("keeps a per-role override too", () => {
    const d = resolveRouting({ engine: "auto", autoPolicy: "quality_first", privacyMode: "default", advanced: { conversation: "local" }, available: ["openai"] });
    expect(d.conversation).toBe("local");
  });

  it("still moves an automatic pick off a provider that is not up", () => {
    const d = resolveRouting({ engine: "auto", autoPolicy: "quality_first", privacyMode: "default", available: ["local"] });
    expect(d.conversation).toBe("local");
  });
});
