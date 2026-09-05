import { describe, expect, it } from "vitest";
import { AddressDetector } from "./addressDetector.js";

/**
 * A romaji character name is never what Japanese speech recognition writes: 「ゆい」, not "Yui".
 * Without the character pack's aliases the detector never fires in a Japanese meeting and the
 * character observes forever — this locks that in.
 */
const d = new AddressDetector({ names: ["Yui", "ゆい", "ユイ", "結衣"] });

describe("address detection with Japanese readings of a romaji name", () => {
  for (const line of ["ゆいさん、聞こえていますか？", "ねえゆい、自己紹介して", "ゆい、これどう思う？", "ユイさん、教えて"]) {
    it(`addressed: ${line}`, () => expect(d.detect(line).addressed).toBe(true));
  }
  it("a plain greeting keeps the character observing", () => expect(d.detect("こんにちは").addressed).toBe(false));
  it("a third-person mention keeps the character observing", () => expect(d.detect("ゆいがそう言ってた").addressed).toBe(false));
  // Run 78: the rescore's 「ユイが昨日そう言ってたよね」 read as "without a request" — an adverb between が and 言ってた.
  it("reports 「…がそう言ってた」 as third person, not merely as a mention", () => expect(d.detect("ゆいが昨日そう言ってたよね").reason).toBe("name mentioned in third person"));
});

/**
 * What the recogniser actually wrote for 「ゆい、」 in Gate #8 runs 10–13: 「い、今どう思う？」
 * 「うい、今どう思う？」「つい今どう思う？」「い今日予定を教えて。」. Each was a call that went unanswered.
 */
describe("sound-alikes of the name at an utterance onset", () => {
  const s = new AddressDetector({ names: ["Yui", "ゆい"], soundalikes: ["い", "うい", "つい", "ゆ"] });
  for (const line of ["い、今どう思う？", "うい、今どう思う？", "つい今どう思う？", "い今日予定を教えて。", "ゆ、これどう思う"]) {
    it(`addressed: ${line}`, () => expect(s.detect(line)).toMatchObject({ addressed: true, reason: "vocative (sound-alike)" }));
  }
  for (const line of ["つい言っちゃった", "つい言っちゃった、どう思う？", "い、そうだね", "いつ帰る？", "ついでに聞くけど、田中さんは？", "い？", "うい？", "ゆ、？"]) {
    it(`not addressed: ${line}`, () => expect(s.detect(line).addressed).toBe(false));
  }
  it("without the option nothing changes", () => expect(d.detect("つい今どう思う？").addressed).toBe(false));

  it("a question ending in 「と思う？」 asks the character, it does not talk about her (run 96)", () => {
    const d = new AddressDetector({ names: ["Yui", "ゆい", "ユイ", "結衣", "唯"] });
    // 「ゆい、これはどう思う？」 with 「どう」 lost in an ears hole, as the streaming recogniser wrote it …
    expect(d.detect("唯イ、これはと思う？")).toMatchObject({ addressed: true, reason: "name + question/request" });
    // … and as the rescore rewrote it.
    expect(d.detect("ゆいこれはと思う?")).toMatchObject({ addressed: true });
    // Narration stays narration.
    expect(d.detect("ゆいはそれでいいと思う。")).toMatchObject({ addressed: false, reason: "name mentioned in third person" });
    expect(d.detect("ゆいが昨日そう言ってたよね")).toMatchObject({ addressed: false, reason: "name mentioned in third person" });
  });
});
