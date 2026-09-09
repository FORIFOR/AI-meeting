import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { estimateMeetingCredits, nonNegativeInput, readLedger, summarizeCredits } from "./costs.js";
const fixture = () => JSON.parse(readFileSync(new URL("../../public/meeting-credit-usage.json", import.meta.url), "utf8"));
describe("reconciled cost display", () => {
  it("reconciles all 27 actual charges with the confirmed balance", () => {
    const d = readLedger(fixture())!;
    expect(d).not.toBeNull();
    const s = summarizeCredits(d);
    expect(s.botCount).toBe(27); expect(s.consumedCredits).toBe(4.53);
    expect(s.usageUsd).toBeCloseTo(2.265);
    expect(s.groups.reduce((n, g) => n + g.credits, 0)).toBeCloseTo(4.53);
  });
  it("does not confuse topups with reduced consumption", () => {
    const d = fixture(); d.transactions.push({ at: d.checkedAt, kind: "purchase", centicredits: 10000, label: "購入" }); d.balanceCenticredits += 10000;
    expect(summarizeCredits(readLedger(d)!).consumedCredits).toBe(4.53);
  });
  it("rejects missing, contradictory or invalid financial records instead of reporting zero", () => {
    expect(readLedger({})).toBeNull();
    const d = fixture(); d.balanceCenticredits++; expect(readLedger(d)).toBeNull();
    d.balanceCenticredits--; d.transactions[0].kind = "unknown"; expect(readLedger(d)).toBeNull();
    const d2 = fixture(); d2.transactions[0].centicredits = NaN; expect(readLedger(d2)).toBeNull();
  });
  it("rounds each bot before summing and validates calculator input", () => {
    expect(estimateMeetingCredits(1, 2)).toBe(.04);
    expect(estimateMeetingCredits(30, 1)).toBe(.5);
    expect(estimateMeetingCredits(30, 2)).toBe(1);
    expect(estimateMeetingCredits(0, 1)).toBe(0);
    for (const [m,b] of [[-1,1],[30,0],[30,1.5],[Infinity,1]] as const) expect(estimateMeetingCredits(m,b)).toBeNull();
    expect(nonNegativeInput("")).toBeNull(); expect(nonNegativeInput(" ")).toBeNull();
    expect(nonNegativeInput("0")).toBe(0); expect(nonNegativeInput("-1")).toBeNull();
  });
});
