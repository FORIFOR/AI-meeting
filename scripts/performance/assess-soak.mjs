/** Assess observed browser audio performance. This does not certify semantic quality or release. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function assessSoak(report) {
  const s = report.summary ?? {};
  const checks = [];
  const check = (id, valid, passed, observed, requirement) => checks.push({ id, status: !valid ? 'BLOCKED' : passed ? 'PASS' : 'FAIL', observed: observed ?? null, requirement });
  const number = (v) => Number.isFinite(v) && v >= 0;
  check('duration', number(s.elapsedMs) && number(report.minutes) && report.minutes > 0,
    s.survived === true && s.elapsedMs >= report.minutes * 60000 - 2000, s.elapsedMs, 'survive requested duration');
  check('heard', number(s.expectedUtterancesFromWav) && s.expectedUtterancesFromWav > 0 && number(s.userUtterancesHeard),
    s.userUtterancesHeard / s.expectedUtterancesFromWav >= .98, s.userUtterancesHeard / s.expectedUtterancesFromWav, '>= 98% of expected utterances (count proxy; content review required)');
  check('answered', number(s.answeredRatio), s.answeredRatio >= .98, s.answeredRatio, '>= 98% (timing proxy; content review required)');
  for (const [key, target] of [['p50', 700], ['p95', 1500]]) {
    const v = s.turnLatency?.[key];
    check(`latency.${key}`, number(v) && s.turnLatency?.n >= 100, v <= target, v, `<= ${target}ms, >= 100 samples`);
  }
  check('interrupt', number(s.bargeInStop?.ms) && s.bargeInStop?.n >= 20,
    s.bargeInStop?.ms <= 150, s.bargeInStop?.ms, '<= 150ms (HUD maximum), >= 20 samples');
  for (const name of ['consoleErrors', 'pageErrors', 'httpErrors']) {
    check(name, Array.isArray(report[name]), report[name]?.length === 0, report[name]?.length, '0 errors');
  }
  check('fatalToasts', Array.isArray(report.toasts), !report.toasts?.some(x => /fatal|BLOCKED_BY/i.test(x.text)), report.toasts?.length, 'no fatal toast');
  return { status: checks.some(x => x.status === 'FAIL') ? 'FAIL' : checks.some(x => x.status === 'BLOCKED') ? 'BLOCKED' : 'PASS', checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) { console.error('Usage: pnpm performance:assess <observed-soak-report.json>'); process.exit(2); }
  const result = assessSoak(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : result.status === 'FAIL' ? 1 : 2;
}
