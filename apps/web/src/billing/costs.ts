export interface CreditLedger {
  schemaVersion: 1;
  checkedAt: string;
  scope: string;
  openingCenticredits: number;
  balanceCenticredits: number;
  usdPerCredit: number;
  transactions: { at: string; kind: "usage" | "purchase" | "grant" | "adjustment"; centicredits: number; label: string }[];
}
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n);
/** Reconcile the complete ledger before calling an amount actual usage. Never infer consumption from balance alone. */
export function readLedger(value: unknown): CreditLedger | null {
  if (!value || typeof value !== "object") return null;
  const d = value as CreditLedger;
  if (d.schemaVersion !== 1 || !Number.isFinite(Date.parse(d.checkedAt)) || Date.parse(d.checkedAt) > Date.now() + 60000 || typeof d.scope !== "string" || !integer(d.openingCenticredits) || !integer(d.balanceCenticredits) || !Number.isFinite(d.usdPerCredit) || d.usdPerCredit <= 0 || !Array.isArray(d.transactions)) return null;
  if (d.transactions.some(t => !t || !integer(t.centicredits) || !Number.isFinite(Date.parse(t.at)) || Date.parse(t.at) > Date.parse(d.checkedAt) || typeof t.label !== "string" || !["usage", "purchase", "grant", "adjustment"].includes(t.kind) || (t.kind === "usage" && t.centicredits >= 0) || (["purchase", "grant"].includes(t.kind) && t.centicredits <= 0))) return null;
  return d.openingCenticredits + d.transactions.reduce((n, t) => n + t.centicredits, 0) === d.balanceCenticredits ? d : null;
}
export function summarizeCredits(d: CreditLedger) {
  const used = d.transactions.filter(t => t.kind === "usage");
  const consumedCredits = -used.reduce((n, t) => n + t.centicredits, 0) / 100;
  return { consumedCredits, usageUsd: consumedCredits * d.usdPerCredit, botCount: used.length,
    groups: [...new Set(used.map(t => t.label))].map(label => ({ label, credits: -used.filter(t => t.label === label).reduce((n, t) => n + t.centicredits, 0) / 100 })) };
}
/** Planning only: provider rounds each bot's active duration up to 0.01 credit. Admission wait may also be billed. */
export function estimateMeetingCredits(minutes: number, bots: number): number | null {
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440 || !Number.isSafeInteger(bots) || bots < 1 || bots > 100) return null;
  return Math.max(0, Math.ceil(minutes * 100 / 60 - 1e-9)) * bots / 100;
}
export function nonNegativeInput(s: string): number | null {
  if (!s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
