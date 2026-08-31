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
});
