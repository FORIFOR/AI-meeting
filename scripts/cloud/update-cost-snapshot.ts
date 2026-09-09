/** Import a reconciled, operator-reviewed ledger. Never read browser cookies or guess missing billing data. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readLedger, summarizeCredits } from "../../apps/web/src/billing/costs.js";
const input = process.argv[2];
if (!input) throw new Error("Usage: pnpm exec tsx scripts/cloud/update-cost-snapshot.ts <reviewed-ledger.json>");
const ledger = readLedger(JSON.parse(readFileSync(resolve(input), "utf8")));
if (!ledger) throw new Error("Invalid ledger: transactions must reconcile to the confirmed balance");
const clean = { schemaVersion: ledger.schemaVersion, checkedAt: ledger.checkedAt, scope: ledger.scope,
  openingCenticredits: ledger.openingCenticredits, balanceCenticredits: ledger.balanceCenticredits,
  usdPerCredit: ledger.usdPerCredit, transactions: ledger.transactions.map(t => ({ at: t.at, kind: t.kind, centicredits: t.centicredits, label: t.label })) };
writeFileSync(resolve("apps/web/public/meeting-credit-usage.json"), JSON.stringify(clean, null, 2) + "\n");
console.log(`Verified ${summarizeCredits(ledger).consumedCredits.toFixed(2)} credits consumed; ${(ledger.balanceCenticredits / 100).toFixed(2)} remaining. Rebuild and deploy to publish.`);
