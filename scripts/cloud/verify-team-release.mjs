import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const steps = [['pnpm', ['typecheck']], ['pnpm', ['test']], ['pnpm', ['build:oss']], ['node', ['scripts/verification/team-readiness.mjs']]];
const startedAt = new Date().toISOString(), results = [];
for (const [command, args] of steps) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  results.push({ command: [command, ...args].join(' '), passed: result.status === 0 });
  if (result.status !== 0) break;
}
const passed = results.length === steps.length && results.every(r => r.passed);
mkdirSync('artifacts/team-cloud', { recursive: true });
writeFileSync('artifacts/team-cloud/release-gate.json', JSON.stringify({ profile: 'team-tasks-3m-v1', startedAt, finishedAt: new Date().toISOString(), passed, results }, null, 2) + '\n');
if (!passed) process.exitCode = 1;
