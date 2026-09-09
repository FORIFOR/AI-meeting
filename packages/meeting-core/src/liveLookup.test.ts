import { describe, expect, it } from "vitest";
import { LIVE_LOOKUP_TOOL, parseLookupArguments, renderLookup } from "./liveLookup.js";

describe("the live lookup the character may call", () => {
  it("takes only the two kinds it declares, whatever the model sends", () => {
    expect(parseLookupArguments({ kind: "news" })).toEqual({ kind: "news", query: undefined, location: undefined });
    expect(parseLookupArguments({ kind: "WEATHER", location: " 大阪 " })).toEqual({ kind: "weather", query: undefined, location: "大阪" });
    expect(parseLookupArguments({ kind: "web_search", query: "x" })).toBeNull();
    expect(parseLookupArguments({})).toBeNull();
    // A model that sends an essay as a topic does not get to send an essay to the news service.
    expect(parseLookupArguments({ kind: "news", query: "あ".repeat(500) })?.query).toHaveLength(80);
  });

  it("hands back a few facts, or the reason there are none", () => {
    const at = "2026-09-07T12:00:00.000Z";
    expect(renderLookup({ facts: ["a", "b", "c", "d", "e", "f"], at })).toEqual({ facts: ["a", "b", "c", "d", "e"], at });
    expect(renderLookup({ facts: [], at, error: "offline" })).toEqual({ error: "offline", at });
  });

  it("describes itself as the last resort, not a browser", () => {
    expect(LIVE_LOOKUP_TOOL.description).toContain("今この瞬間");
    expect(LIVE_LOOKUP_TOOL.parameters.properties.kind.enum).toEqual(["news", "weather"]);
  });
});
it('does not turn retrieval time into article publication time',()=>{
 const at='2026-09-08T17:00:00Z';
 const old={title:'old',url:'https://example.com/old',source:'source',publishedAt:'2026-09-08T10:00:00Z'};
 const fresh={...old,title:'fresh',url:'https://example.com/new',publishedAt:'2026-09-08T16:00:00Z'};
 expect(renderLookup({facts:['old','fresh'],at,articles:[old,fresh]})).toMatchObject({facts:['fresh'],articles:[fresh]});
 expect(renderLookup({facts:['old'],at,articles:[old]})).toMatchObject({error:expect.stringContaining('No articles published today')});
});
