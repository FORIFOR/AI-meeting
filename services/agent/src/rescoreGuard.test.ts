import { describe, expect, it } from "vitest";
import { readingOverlap, rescoreRejection } from "./rescoreGuard.js";

describe("rescore guard", () => {
  it("keeps a second reading that refines the first", () => {
    expect(rescoreRejection("こんにちは", "こんにちは、ゆいさん", 0.82)).toBeUndefined();
    expect(rescoreRejection("ゆイ、これはどう思う？", "ゆい、これはどう思う?", 2.66)).toBeUndefined();
    expect(rescoreRejection("ゆい寮の予定を教えて。", "ゆい、今日の予定を教えて。", 2.4)).toBeUndefined();
  });
  it("drops a made-up name on a short clip (run 84's メタリオ)", () => {
    expect(rescoreRejection("見たよ。", "メタリオ", 1.42)).toMatch(/short clip/);
    expect(rescoreRejection("メたよ。", "メタリオ", 1.4)).toMatch(/short clip/);
    expect(rescoreRejection("Okay.", "はい", 0.6)).toMatch(/short clip/);
  });
  it("a wholesale disagreement on a long clip is left to the second pass", () => {
    expect(rescoreRejection("のカロ島ち一緒にカロのまい。", "ブーブー", 3.1)).toBeUndefined();
  });
  it("drops whisper's stock silence readings at any length", () => {
    expect(rescoreRejection("あ？", "ご視聴ありがとうございました", 0.9)).toBe("stock hallucination");
    expect(rescoreRejection("す。", "ご視聴ありがとうございました。", 4.0)).toBe("stock hallucination");
    // …unless the first pass heard the same words: then it is what was said
    expect(rescoreRejection("ありがとうございました", "ありがとうございました。", 1.5)).toBeUndefined();
  });
  it("overlap ignores punctuation, spacing and kana width", () => {
    expect(readingOverlap("ゆイ、これはどう思う？", "ゆい、これはどう思う?")).toBe(1);
    expect(readingOverlap("見たよ", "メタリオ")).toBe(0);
    expect(readingOverlap("", "")).toBe(1);
  });
});
