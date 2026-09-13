import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const project = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0307428960';
const broker = process.env.TEAM_BROKER_URL || 'https://ai-meeting-broker-pdygkns5gq-an.a.run.app';
const database = 'ai-meeting-teams';
const gcloud = args => JSON.parse(execFileSync('gcloud', [...args, `--project=${project}`, '--format=json'], { encoding: 'utf8', maxBuffer: 4_000_000 }));
const db = gcloud(['firestore', 'databases', 'describe', `--database=${database}`]);
const ttls = gcloud(['firestore', 'fields', 'ttls', 'list', `--database=${database}`]);
const schedules = gcloud(['firestore', 'backups', 'schedules', 'list', `--database=${database}`]);
const indexes = gcloud(['firestore', 'indexes', 'composite', 'list', `--database=${database}`]);
const backups = gcloud(['firestore', 'backups', 'list', '--location=asia-northeast1']).filter(b => b.database === db.name);
const status = await fetch(`${broker}/api/team/status`);
const health = await (await fetch(`${broker}/health`)).json();
const denied = await fetch(`${broker}/api/team/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"unauthorized"}' });
const evidence = JSON.parse(readFileSync(process.env.TEAM_EVIDENCE || 'artifacts/team-cloud/verification.json', 'utf8'));
const checks = {
  datastoreProbeHealthy: status.status === 200 && (await status.json()).ready === true,
  tokyoDedicatedDatabase: db.locationId === 'asia-northeast1',
  pointInTimeRecovery: db.pointInTimeRecoveryEnablement === 'POINT_IN_TIME_RECOVERY_ENABLED',
  accidentalDatabaseDeletionProtected: db.deleteProtectionState === 'DELETE_PROTECTION_ENABLED',
  taskAndPolicyAndAuditTTL: ['ai_meeting_teams', 'ai_meeting_team_workspaces', 'ai_meeting_team_audit'].every(c => ttls.some(t => t.name.includes(`/collectionGroups/${c}/`) && t.ttlConfig?.state === 'ACTIVE')),
  dailyBackupScheduledFor7Days: schedules.some(s => s.dailyRecurrence && s.retention === '604800s'),
  auditIndexReady: indexes.some(i => i.name.includes('/collectionGroups/ai_meeting_team_audit/') && i.state === 'READY'),
  publicPaidRoutesClosed: health.publicAccess?.mode === 'demo_only',
  teamProfileEnabled: health.teamWorkspaces?.enabled && health.teamWorkspaces?.profile === 'team-tasks-3m-v1',
  boundedVoice: health.hostedAccess?.sessionSeconds === 180 && health.hostedAccess?.dailySessions === 1,
  authenticationEnforced: denied.status === 401,
  cloudAcceptancePassed: evidence.success === true && evidence.profile === 'team-tasks-3m-v1',
  realVoiceAndRevocationPassed: evidence.checks?.realVoiceToTeamTask === true && evidence.checks?.activeVoiceRevoked === true,
  evidenceFresh: Date.now() - Date.parse(evidence.finishedAt) < 24 * 3600000,
  syntheticAccountsRemoved: evidence.cleanup?.syntheticAccountsDeleted === true,
};
const report = { schema: 'rcai.team-readiness.v1', profile: 'team-tasks-3m-v1', checkedAt: new Date().toISOString(), sourceCommit: evidence.sourceCommit, ready: Object.values(checks).every(v => v === true), checks, completedBackups: backups.length, notes: ['Technical acceptance for five-member, 30-day, 3-minute voice/task teams only.', 'No claim of human conversation quality, enterprise SSO, SLA or unrestricted production readiness.', 'The backup schedule starts future daily backups; historical-read restore is separately tested.'] };
mkdirSync('artifacts/team-cloud', { recursive: true }); writeFileSync('artifacts/team-cloud/readiness.json', JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report)); if (!report.ready) process.exitCode = 1;
