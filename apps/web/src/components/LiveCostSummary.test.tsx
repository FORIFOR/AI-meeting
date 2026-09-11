import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveCostSummary } from "./LiveCostSummary.js";
it("distinguishes an incomplete estimate from a zero price", () => {
  const unknown = renderToStaticMarkup(<LiveCostSummary counters={{ pricedTurns: 0, unpricedTurns: 1, estimatedMicroUsd: 0 }} />);
  expect(unknown).toContain("集計中"); expect(unknown).not.toContain("$0.0000");
  const priced = renderToStaticMarkup(<LiveCostSummary counters={{ pricedTurns: 2, unpricedTurns: 1, estimatedMicroUsd: 12345 }} />);
  expect(priced).toContain("AI処理の集計"); expect(priced).toContain("未集計"); expect(priced).toContain("料金の具体額は表示していません");
  expect(priced).not.toContain("$");
});
