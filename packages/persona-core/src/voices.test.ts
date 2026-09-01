import { describe, expect, it } from "vitest";
import { VOICE_OPTIONS, localVoiceOptions, resolveVoice } from "./voices.js";

describe("voice choice", () => {
  it("falls back to the character's own voice when the user chose nothing", () => {
    expect(resolveVoice("openai", "marin", undefined)).toBe("marin");
    expect(resolveVoice("openai", "marin", "")).toBe("marin");
  });
  it("uses the user's choice when it is a voice the provider offers", () => {
    expect(resolveVoice("openai", "marin", "cedar")).toBe("cedar");
    expect(resolveVoice("google", "Kore", "Aoede")).toBe("Aoede");
  });
  it("ignores a cloud voice the provider does not have, rather than sending it", () => {
    expect(resolveVoice("openai", "marin", "Kore")).toBe("marin");
  });
  it("accepts any local voice: the list belongs to the machine, not to this package", () => {
    expect(resolveVoice("local", "Kyoko", "com.apple.eloquence.ja-JP.Flo")).toBe("com.apple.eloquence.ja-JP.Flo");
  });
  it("names local voices by their last identifier segment", () => {
    const opts = localVoiceOptions(["com.apple.voice.compact.ja-JP.Kyoko", "com.apple.eloquence.ja-JP.Flo"]);
    expect(opts.map((o) => o.label)).toEqual(["Kyoko", "Flo"]);
    expect(opts[1]!.id).toBe("com.apple.eloquence.ja-JP.Flo");
  });
  it("keeps the built-in list when the agent reports nothing", () => {
    expect(localVoiceOptions(undefined)).toEqual(VOICE_OPTIONS.local);
    expect(localVoiceOptions([])).toEqual(VOICE_OPTIONS.local);
  });
});
