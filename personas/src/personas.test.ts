import { describe, expect, it } from "vitest";
import { buildSystemPrompt, createSessionConfig, validatePersona } from "@rcai/persona-core";
import { DEFAULT_PERSONA_ID, createPersonaRegistry, getPersona, personas, personasByMode } from "./catalog.js";

describe("bundled personas", () => {
  it("all validate, have unique ids, and cover every mode", () => {
    expect(personas.length).toBeGreaterThanOrEqual(13);
    expect(new Set(personas.map((p) => p.id)).size).toBe(personas.length);
    for (const p of personas) expect(() => validatePersona(p)).not.toThrow();
    for (const [mode, list] of Object.entries(personasByMode)) {
      expect(list.length, mode).toBeGreaterThan(0);
      expect(getPersona(DEFAULT_PERSONA_ID[mode as keyof typeof DEFAULT_PERSONA_ID]).mode).toBe(mode);
    }
    expect(personasByMode.english_lesson.length).toBe(7);
  });
  it("renders every system prompt with defaults and no leftover placeholders", () => {
    for (const p of personas) {
      const prompt = buildSystemPrompt({ persona: p });
      expect(prompt, p.id).not.toMatch(/\{\{/);
      expect(prompt.length, p.id).toBeGreaterThan(100);
      const ja = p.language.startsWith("ja");
      expect(prompt, p.id).toContain(ja ? "【会話ルール】" : "[Conversation rules]");
      if (p.opening) expect(p.opening).not.toMatch(/\{\{/);
    }
  });
  it("respects spec §20/§22 turn policies", () => {
    for (const p of personas) {
      expect(p.turnPolicy.maxSentences, p.id).toBeLessThanOrEqual(3);
      expect(p.speakingStyle.energy).toBeGreaterThanOrEqual(0);
      expect(p.speakingStyle.energy).toBeLessThanOrEqual(1);
    }
    for (const p of personasByMode.english_lesson) expect(p.turnPolicy.correctionPolicy, p.id).toBe("deferred");
    for (const p of personasByMode.interview) {
      expect(p.turnPolicy.correctionPolicy).toBe("none");
      expect(p.evaluationProfile).toBe("interview_standard");
      expect(p.systemPrompt).toMatch(/採点|score/i);
    }
    expect(getPersona("sales_customer_ja").evaluationProfile).toBe("sales_roleplay");
  });
  it("interviewer params flow into prompt and session config", () => {
    const p = getPersona("interviewer_ja");
    expect(p.params?.map((x) => x.key)).toEqual(["position", "companyStyle", "difficulty", "interviewStyle"]);
    const prompt = buildSystemPrompt({ persona: p, params: { position: "データエンジニア", companyStyle: "スタートアップ", difficulty: "Hard" } });
    expect(prompt).toContain("データエンジニア");
    expect(prompt).toContain("スタートアップ");
    expect(prompt).toContain("Hard");
    expect(prompt).toContain("一般面接");
    const cfg = createSessionConfig({ persona: p, providerId: "local", privacyMode: "strict_local", params: { position: "PM" } });
    expect(cfg.mode).toBe("interview");
    expect(cfg.privacyMode).toBe("strict_local");
    expect(cfg.providerOptions?.opening).toContain("自己紹介");
    expect(createPersonaRegistry().list("interview").map((x) => x.id)).toEqual(["interviewer_ja", "interviewer_en"]);
  });
});
