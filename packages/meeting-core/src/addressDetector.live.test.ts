import { describe, expect, it } from "vitest";
import { AddressDetector, normalizeForMatch } from "./addressDetector.js";

/**
 * Transcripts taken verbatim from the 10-minute Attendee gate on 2026-09-02.
 *
 * The person called the character by name six times. The recogniser wrote 「ゆイ」 — hiragana then
 * katakana, inside one two-mora word — so the name matched nothing, the character was never
 * addressed, and it stayed silent for the whole meeting while it went on generating answers.
 */
const d = new AddressDetector({ names: ["Yui", "ゆい", "ユイ", "結衣"] });

describe("the name as a Japanese recogniser actually writes it", () => {
  for (const line of ["ゆイ、今 どう 思う？", "ゆイ、今 どう思う？", "ユい、今日の予定を教えて", "ﾕｲ、どう？"]) {
    it(`addressed: ${line}`, () => expect(d.detect(line).addressed).toBe(true));
  }

  it("still refuses a third-person mention, whatever the script", () => {
    expect(d.detect("ゆイが昨日そう言ってた").addressed).toBe(false);
    expect(d.detect("ユイのことを話してた").addressed).toBe(false);
  });

  it("does not turn a genuinely wrong transcript into a match", () => {
    // Also from that meeting. These are not the name, and folding scripts must not make them one.
    expect(d.detect("ニい。今日の予定教えて。").addressed).toBe(false);
    expect(d.detect("さい.").addressed).toBe(false);
    expect(d.detect("イ今日の 予定 を 教せて。").addressed).toBe(false);
  });

  it("folds katakana, width and case, and leaves everything else alone", () => {
    expect(normalizeForMatch("ユイ")).toBe("ゆい");
    expect(normalizeForMatch("ﾕｲ")).toBe("ゆい");
    expect(normalizeForMatch("YUI")).toBe("yui");
    expect(normalizeForMatch("結衣")).toBe("結衣");
    expect(normalizeForMatch("ラーメン")).toBe("らーめん"); // ー has no hiragana counterpart
  });
});
