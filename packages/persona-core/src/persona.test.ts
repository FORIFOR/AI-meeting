import { describe, expect, it } from "vitest";
import { PersonaRegistry, PersonaValidationError, validatePersona, type Persona } from "./persona.js";
import { buildSystemPrompt, createSessionConfig, fillTemplate } from "./prompt.js";

const interviewer: Persona = {
  id: "interviewer_ja",
  name: "面接官",
  mode: "interview",
  systemPrompt: "あなたは{{companyStyle}}の面接官です。応募職種は{{position}}。難易度は{{difficulty}}。",
  language: "ja-JP",
  speakingStyle: { speed: "normal", energy: 0.4, politeness: "polite", sentenceLength: "short" },
  turnPolicy: { maxSentences: 3, allowSilenceMs: 2500, backchannel: true, interruptible: true, correctionPolicy: "none" },
  motionProfile: "interviewer_v1",
  evaluationProfile: "interview_standard",
  params: [
    { key: "position", label: "Position", type: "text", default: "Software Engineer" },
    { key: "companyStyle", label: "Company style", type: "select", options: ["日系大手", "外資", "スタートアップ"], default: "日系大手" },
    { key: "difficulty", label: "Difficulty", type: "select", options: ["Easy", "Standard", "Hard"], default: "Standard" },
  ],
};

describe("persona", () => {
  it("validates and registers", () => {
    const reg = new PersonaRegistry().register(interviewer);
    expect(reg.get("interviewer_ja").mode).toBe("interview");
    expect(reg.list("interview").length).toBe(1);
    expect(() => validatePersona({ ...interviewer, mode: "dance" })).toThrow(PersonaValidationError);
  });
  it("fills templates with params then defaults", () => {
    expect(fillTemplate("{{position}} / {{companyStyle}} / {{missing}}", { position: "PM" }, interviewer)).toBe("PM / 日系大手 / ");
  });
  it("builds a Japanese prompt with identity, role, style and policy", () => {
    const prompt = buildSystemPrompt({ persona: interviewer, character: { manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] } }, params: { position: "Backend Engineer" } });
    expect(prompt).toContain("あなたの名前は「Yui」です");
    expect(prompt).toContain("Backend Engineer");
    expect(prompt).toContain("日系大手");
    expect(prompt).toContain("【会話ルール】");
    expect(prompt).toContain("質問は一度に一つ");
    expect(prompt).toContain("最大3文");
  });
  it("creates a SessionConfig with the provider voice and no secrets", () => {
    const cfg = createSessionConfig({
      persona: interviewer,
      providerId: "google",
      privacyMode: "default",
      character: { manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c/yui", model: "m", expressions: {}, motions: {}, voice: { characterId: "yui", voices: { openai: "marin", google: "Kore", local: "yui_jp" } } },
    });
    expect(cfg.voice).toBe("Kore");
    expect(cfg.mode).toBe("interview");
    expect(cfg.personaId).toBe("interviewer_ja");
    expect(JSON.stringify(cfg)).not.toMatch(/api[_-]?key/i);
  });
  it("lets the user's chosen voice win over the character's default", () => {
    const character = { manifest: { id: "yui", name: "Yui", renderer: "live2d" as const, defaultPersona: "x", supportedLanguages: ["ja-JP"], motionProfile: "m", voiceProfiles: [] }, baseUrl: "/c/yui", model: "m", expressions: {}, motions: {}, voice: { characterId: "yui", voices: { openai: "marin", google: "Kore", local: "Kyoko" } } };
    expect(createSessionConfig({ persona: interviewer, providerId: "google", privacyMode: "default", character, voiceId: "Aoede" }).voice).toBe("Aoede");
    expect(createSessionConfig({ persona: interviewer, providerId: "google", privacyMode: "default", character, voiceId: undefined }).voice).toBe("Kore");
  });
});
