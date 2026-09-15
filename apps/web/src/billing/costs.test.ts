import { describe, expect, it } from "vitest";
import { estimateMeetingCredits, nonNegativeInput, readLedger, summarizeCredits } from "./costs.js";
import { creditLedgerFixture as fixture } from "./testFixtures.js";
describe("reconciled cost display", () => {
  it("reconciles multiple synthetic charges with the recorded balance", () => {
    const d = readLedger(fixture())!;
    expect(d).not.toBeNull();
    const s = summarizeCredits(d);
    expect(s.botCount).toBe(3); expect(s.consumedCredits).toBe(3);
    expect(s.usageUsd).toBeCloseTo(1.5);
    expect(s.groups).toEqual([{ label: "Synthetic session A", credits: 2.5 }, { label: "Synthetic session B", credits: 0.5 }]);
    expect(s.groups.reduce((n, g) => n + g.credits, 0)).toBeCloseTo(3);
  });
  it("does not confuse topups with reduced consumption", () => {
    const d = fixture(); d.transactions.push({ at: d.checkedAt, kind: "purchase", centicredits: 10000, label: "購入" }); d.balanceCenticredits += 10000;
    expect(summarizeCredits(readLedger(d)!).consumedCredits).toBe(3);
  });
  it("rejects missing, contradictory or invalid financial records instead of reporting zero", () => {
    expect(readLedger({})).toBeNull();
    const d = fixture(); d.balanceCenticredits++; expect(readLedger(d)).toBeNull();
    d.balanceCenticredits--; d.transactions[0]!.kind = "unknown"; expect(readLedger(d)).toBeNull();
    const d2 = fixture(); d2.transactions[0]!.centicredits = NaN; expect(readLedger(d2)).toBeNull();
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
