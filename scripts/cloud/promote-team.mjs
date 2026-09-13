import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const revision = process.argv[2];
if (!/^ai-meeting-broker-[0-9]{5}-[a-z0-9]{3}$/.test(revision ?? '')) throw new Error('Pass the verified Cloud Run revision');
const project = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0307428960';
const service = 'ai-meeting-broker', region = 'asia-northeast1';
const candidate = 'https://team-check---ai-meeting-broker-pdygkns5gq-an.a.run.app';
const production = 'https://ai-meeting-broker-pdygkns5gq-an.a.run.app';
const gcloud = args => JSON.parse(execFileSync('gcloud', [...args, `--project=${project}`, '--quiet', '--format=json'], { encoding: 'utf8', maxBuffer: 4_000_000 }));
const describe = () => gcloud(['run', 'services', 'describe', service, `--region=${region}`]);
const before = describe(), previous = before.status.traffic.filter(t => t.percent > 0);
if (previous.length !== 1 || previous[0].percent !== 100) throw new Error('A canary rollout is already active; do not overwrite it');
if (!before.status.traffic.some(t => t.tag === 'team-check' && t.revisionName === revision)) throw new Error('Candidate does not match the QA URL');
const config = gcloud(['run', 'revisions', 'describe', revision, `--region=${region}`]);
const env = Object.fromEntries(config.spec.containers[0].env.map(e => [e.name, e.value]));
for (const [key, value] of Object.entries({ RCAI_TEAM_WORKSPACES: '1', RCAI_TEAM_FIRESTORE_DATABASE: 'ai-meeting-teams', RCAI_HOSTED_MONTHLY_SESSIONS: '30', RCAI_HOSTED_USER_DAILY_SESSIONS: '1', RCAI_HOSTED_SESSION_SECONDS: '180', RCAI_PUBLIC_DEMO_ONLY: '1' })) if (env[key] !== value) throw new Error(`Unexpected protected setting: ${key}`);
if (config.metadata.annotations['autoscaling.knative.dev/maxScale'] !== '1') throw new Error('Unexpected instance spending limit');
execFileSync(process.execPath, ['scripts/verification/team-readiness.mjs'], { stdio: 'inherit', env: { ...process.env, TEAM_BROKER_URL: candidate } });
const acceptance = JSON.parse(readFileSync('artifacts/team-cloud/verification.json', 'utf8'));
if (acceptance.backendRevision !== revision || acceptance.backendImageDigest !== config.status.imageDigest) throw new Error('Acceptance evidence belongs to a different deployed image');
if (acceptance.broker !== candidate) throw new Error('Cloud acceptance was not performed against the candidate');
async function smoke(base) {
  const status = await fetch(`${base}/api/team/status`, { signal: AbortSignal.timeout(15000) });
  if (status.status !== 200 || !(await status.json()).ready) throw new Error('Team datastore readiness failed');
  for (const path of ['/api/token/gemini', '/api/token/openai', '/api/meeting/attendee/bots']) {
    const response = await fetch(`${base}${path}`, { method: 'POST', signal: AbortSignal.timeout(15000) });
    if (response.status !== 403) throw new Error('A direct billed route is open');
  }
}
await smoke(candidate);
if (describe().status.traffic.find(t => t.percent === 100)?.revisionName !== previous[0].revisionName) throw new Error('Production changed during verification');
gcloud(['run', 'services', 'update-traffic', service, `--region=${region}`, `--to-revisions=${revision}=100`]);
try { await smoke(production); }
catch (error) {
  if (describe().status.traffic.find(t => t.percent === 100)?.revisionName === revision) gcloud(['run', 'services', 'update-traffic', service, `--region=${region}`, `--to-revisions=${previous[0].revisionName}=100`]);
  throw error;
}
mkdirSync('artifacts/team-cloud', { recursive: true });
writeFileSync('artifacts/team-cloud/promotion.json', JSON.stringify({ profile: 'team-tasks-3m-v1', promotedAt: new Date().toISOString(), revision, previousRevision: previous[0].revisionName, image: config.status.imageDigest, productionSmokePassed: true, automaticRollbackOnFailure: true }, null, 2) + '\n');
console.log(JSON.stringify({ promoted: true, revision }));
