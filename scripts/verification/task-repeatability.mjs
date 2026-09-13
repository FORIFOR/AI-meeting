import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve('artifacts/task-repeatability');
mkdirSync(output, { recursive: true });
const runs = [];
for (let i = 1; i <= 10; i++) {
  const directory = resolve(output, `run-${Date.now()}-${i}`);
  const started = Date.now();
  try {
    execFileSync(process.execPath, ['scripts/verification/task-workspace-browser.mjs'], { env: { ...process.env, TASK_QA_DIR: directory }, timeout: 120000, stdio: 'pipe' });
    const evidence = JSON.parse(readFileSync(resolve(directory, 'verification.json')));
    runs.push({ run: i, passed: evidence.passed === true, elapsedMs: Date.now() - started, steps: evidence.steps, pageErrors: evidence.pageErrors, horizontalOverflow: evidence.horizontalOverflow });
  } catch {
    runs.push({ run: i, passed: false, elapsedMs: Date.now() - started });
  }
  console.log(`Task workflow ${i}/10: ${runs.at(-1).passed ? 'PASS' : 'FAIL'}`);
}
const result = { measuredAt: new Date().toISOString(), scope: 'Ten independent headless Chrome profiles. Browser-local task UI only; no microphone, live AI, human conversation, or full voice-demo repeatability claim.', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceDirty: execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim() !== '', runs, passed: runs.every(r => r.passed) };
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.passed ? 0 : 1;
