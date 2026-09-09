import { it, expect } from "vitest";
import { geminiUsageCounters, LiveUsageAccumulator } from "./usage.js";
const model = "gemini-live-2.5-flash-native-audio";
const sample = { promptTokenCount: 100, totalTokenCount: 120, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 80 }, { modality: "TEXT", tokenCount: 20 }], candidatesTokensDetails: [{ modality: "AUDIO", tokenCount: 15 }, { modality: "TEXT", tokenCount: 5 }] };
it("prices Vertex candidate modalities once per completed response, including reprocessed history", () => {
  expect(geminiUsageCounters(sample).output_snd).toBe(15);
  const u = new LiveUsageAccumulator(); u.observe(sample); u.observe(sample); u.complete(model); u.complete(model);
  expect(u.snapshot()).toMatchObject({ estimatedMicroUsd: 440, pricedTurns: 1, unpricedTurns: 0 });
  u.observe(sample); u.complete(model); expect(u.snapshot().estimatedMicroUsd).toBe(880);
});
it("does not price unknown modalities or another model with these rates", () => {
  const u = new LiveUsageAccumulator(); u.observe({ promptTokenCount: 100, totalTokenCount: 120 }); u.complete(model);
  u.observe(sample); u.complete("other-model"); expect(u.snapshot()).toMatchObject({ estimatedMicroUsd: 0, pricedTurns: 0, unpricedTurns: 2 });
});
