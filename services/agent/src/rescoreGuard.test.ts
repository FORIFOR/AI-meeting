import { describe, expect, it } from "vitest";
import { alienKatakana, readingOverlap, rescoreRejection } from "./rescoreGuard.js";

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

  it("drops a katakana name the first pass never heard, in any script (runs 84, 90, 100)", () => {
    // Run 100: the rescore put a person into 「ゆいが昨日そう言ってたよね」 and the character answered to them.
    expect(rescoreRejection("ユイが 昨日そう言って たよ ね。", "ゆいがリノースを言ってたよね", 2.6)).toMatch(/katakana.*リノース/);
    // Run 90: a fragment cut by an ears hole, rescored into a name (long enough to pass the short-clip rule).
    expect(rescoreRejection("ア定ージ目の数字が少し気になったかな。", "なんてエリメが少し気になったかな", 2.4)).toMatch(/エリメ/);
    // A real katakana word the first pass wrote in kana, or already in katakana, is not alien.
    expect(rescoreRejection("すけじゅーるを確認して", "スケジュールを確認して", 2.4)).toBeUndefined();
    expect(rescoreRejection("スケジュール確認", "スケジュールを確認して", 2.4)).toBeUndefined();
    // Two characters are a mora pair, not a name (「ユイ」 is the character herself).
    expect(alienKatakana("ゆい、今どう思う？", "ユイ、今どう思う？")).toBeNull();
  });
});
