import { describe, expect, it } from "vitest";
import { describeWeather, geocodeName, headlinesFromRss, lookupLiveInfo } from "./lookup.js";

/**
 * 「今日のニュースを教えて」 had one answer — that she cannot know — and it was the wrong one twice in
 * one day (2026-09-07). Gemini's own grounding is refused on this key for the live model we use, so
 * the character calls a tool, and the tool is this.
 */
describe("what is true right now", () => {
  const rss = `<rss><channel><item><title>伊豆諸島 利島村にレベル5土砂災害特別警報 - NHK</title></item>
    <item><title><![CDATA[高市首相、政調会長らと昼食 &amp; 国会日程を協議 - 読売新聞]]></title></item>
    <item><title>3件目</title></item></channel></rss>`;

  it("reads the headlines out of the feed, without the masthead", () => {
    expect(headlinesFromRss(rss)).toEqual([
      "伊豆諸島 利島村にレベル5土砂災害特別警報",
      "高市首相、政調会長らと昼食 & 国会日程を協議",
      "3件目",
    ]);
    expect(headlinesFromRss(rss, 2)).toHaveLength(2);
    expect(headlinesFromRss("<rss></rss>")).toEqual([]);
  });

  it("asks the geocoder in the one language it answers to", () => {
    // 「東京」 finds nothing; "Tokyo" comes back as 東京都, which is what the character then says.
    expect(geocodeName("東京")).toBe("Tokyo");
    expect(geocodeName("東京都")).toBe("Tokyo");
    expect(geocodeName("大阪府")).toBe("Osaka");
    expect(geocodeName("Berlin")).toBe("Berlin");
    expect(geocodeName("知らない町")).toBe("知らない");
  });

  it("says the weather the way a person would", () => {
    expect(describeWeather("東京都", { temperature_2m: 22.4, weather_code: 2 }, { weather_code: 65, temperature_2m_max: 24.2, temperature_2m_min: 20.6 }))
      .toEqual(["東京都は今薄曇り、気温22度", "今日の東京都は強い雨、最高24度・最低21度"]);
    expect(describeWeather("X", {}, {})).toEqual([]);
  });

  it("returns an error the character can say out loud rather than an empty answer it will fill in", async () => {
    const failing = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const r = await lookupLiveInfo({ kind: "news" }, failing);
    expect(r.body.facts).toEqual([]);
    expect(r.body.error).toContain("503");
    const thrown = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect((await lookupLiveInfo({ kind: "weather" }, thrown)).body.error).toBe("offline");
  });

  it("fetches headlines for a topic when one is asked for", async () => {
    const seen: string[] = [];
    const ok = (async (url: string) => { seen.push(String(url)); return { ok: true, status: 200, text: async () => rss }; }) as unknown as typeof fetch;
    const r = await lookupLiveInfo({ kind: "news", query: "経済" }, ok);
    expect(seen[0]).toContain("/rss/search?q=%E7%B5%8C%E6%B8%88");
    expect(r.body.facts[0]).toContain("伊豆諸島");
    await lookupLiveInfo({ kind: "news" }, ok);
    expect(seen[1]).not.toContain("/search");
  });
});
