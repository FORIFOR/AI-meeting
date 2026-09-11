/** Invented test records. No operator billing, customer IDs or meeting data. */
export function creditLedgerFixture() {
  return {
    schemaVersion: 1,
    checkedAt: "2026-01-03T00:00:00Z",
    scope: "Synthetic unit-test wallet",
    openingCenticredits: 10000,
    balanceCenticredits: 9700,
    usdPerCredit: 0.5,
    transactions: [
      { at: "2026-01-01T10:00:00Z", kind: "usage", centicredits: -125, label: "Synthetic session A" },
      { at: "2026-01-01T11:00:00Z", kind: "usage", centicredits: -50, label: "Synthetic session B" },
      { at: "2026-01-02T10:00:00Z", kind: "usage", centicredits: -125, label: "Synthetic session A" },
    ],
  };
}

export function cloudCostsFixture() {
  return {
    checkedAt: "2026-01-03T00:00:00Z",
    periodStart: "2026-01-01",
    periodEnd: "2026-01-02",
    currency: "JPY",
    gross: 6000,
    savings: 1250,
    net: 4750,
    services: [
      { name: "Synthetic compute", gross: 4000, savings: 1000, net: 3000 },
      { name: "Synthetic storage", gross: 2000, savings: 250, net: 1750 },
    ],
  };
}
