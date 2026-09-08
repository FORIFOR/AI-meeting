/** Read-only accounting gate. An operation must reserve persistently before using this decision. */
import { readFileSync } from 'node:fs';
const policy = JSON.parse(readFileSync(new URL('../../deploy/cloud/budget-policy.json', import.meta.url)));
const args = process.argv.slice(2);
const arg = key => args[args.indexOf(key) + 1];
try {
  if (!args.includes('--ledger') || !args.includes('--month') || !args.includes('--reserve-jpy')) throw Error('Usage: pnpm budget:check --ledger <file> --month YYYY-MM --reserve-jpy <maximum-cost>');
  const month = arg('--month');
  const requested = Number(arg('--reserve-jpy'));
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !Number.isFinite(requested) || requested < 0) throw Error('Invalid month or reservation');
  const ledger = JSON.parse(readFileSync(arg('--ledger'), 'utf8'));
  if (ledger.schemaVersion !== 1 || ledger.currency !== 'JPY' || !Array.isArray(ledger.entries)) throw Error('Invalid ledger');
  // Prevent an incomplete export from being interpreted as zero spend.
  const categories = ['fixed', 'attendee', 'gemini', 'infrastructure'];
  const coverage = ledger.coverage?.[month];
  if (!categories.every(c => coverage?.[c] === true)) throw Error('All four cost categories require reconciliation, even when zero');
  const ids = new Set();
  const totals = Object.fromEntries(categories.map(c => [c, 0]));
  let reserved = 0;
  for (const e of ledger.entries) {
    if (typeof e.id !== 'string' || !e.id || ids.has(e.id)) throw Error('Missing or duplicate entry id');
    ids.add(e.id);
    if (!categories.includes(e.category) || !['actual', 'reservation'].includes(e.kind) || !Number.isFinite(e.jpy) || e.jpy < 0 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(e.month)) throw Error('Invalid cost entry');
    if (e.month !== month) continue;
    if (e.kind === 'actual') totals[e.category] += e.jpy;
    else reserved += e.jpy;
  }
  const actual = Object.values(totals).reduce((a,b) => a+b,0);
  const projected = actual + reserved + requested;
  if (!Number.isFinite(projected)) throw Error('Cost overflow');
  const status = projected > policy.hardMonthlyJpy ? 'STOP' : projected > policy.normalMonthlyJpy ? 'WARN' : 'OK';
  console.log(JSON.stringify({ status, month, actualByCategoryJpy: totals, reservedJpy: reserved, requestedJpy: requested, projectedJpy: projected, normalJpy: policy.normalMonthlyJpy, hardJpy: policy.hardMonthlyJpy, enforced: false }, null, 2));
  process.exitCode = status === 'STOP' ? 1 : 0;
} catch (e) {
  console.error(JSON.stringify({ status: 'BLOCKED', detail: e.message, enforced: false }));
  process.exitCode = 2;
}
