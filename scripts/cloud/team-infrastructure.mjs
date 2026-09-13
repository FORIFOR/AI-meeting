import { execFileSync } from 'node:child_process';
const project = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0307428960';
const database = process.env.TEAM_DATABASE || 'ai-meeting-teams';
function gcloud(args) { return JSON.parse(execFileSync('gcloud', [...args, `--project=${project}`, '--quiet', '--format=json'], { encoding: 'utf8', maxBuffer: 4_000_000 })); }
// Separate from the existing inquiry, Zoom and global voice-usage database.
const info = gcloud(['firestore', 'databases', 'describe', `--database=${database}`]);
if (info.locationId !== 'asia-northeast1' || info.type !== 'FIRESTORE_NATIVE') throw new Error('Unexpected team database location/type');
if (info.pointInTimeRecoveryEnablement !== 'POINT_IN_TIME_RECOVERY_ENABLED' || info.deleteProtectionState !== 'DELETE_PROTECTION_ENABLED') gcloud(['firestore', 'databases', 'update', `--database=${database}`, '--enable-pitr', '--delete-protection']);
const fields = gcloud(['firestore', 'fields', 'ttls', 'list', `--database=${database}`]);
for (const collection of ['ai_meeting_teams', 'ai_meeting_team_workspaces', 'ai_meeting_team_audit']) {
  if (!fields.some(f => f.name.endsWith(`/collectionGroups/${collection}/fields/expiresAt`) && ['ACTIVE', 'CREATING'].includes(f.ttlConfig?.state))) gcloud(['firestore', 'fields', 'ttls', 'update', 'expiresAt', `--collection-group=${collection}`, `--database=${database}`, '--enable-ttl', '--async']);
}
const schedules = gcloud(['firestore', 'backups', 'schedules', 'list', `--database=${database}`]);
if (!schedules.some(s => s.dailyRecurrence && s.retention === '604800s')) {
  if (schedules.some(s => s.dailyRecurrence)) throw new Error('Existing daily backup policy differs; preserve it for review');
  gcloud(['firestore', 'backups', 'schedules', 'create', `--database=${database}`, '--retention=7d', '--recurrence=daily']);
}
const indexes = gcloud(['firestore', 'indexes', 'composite', 'list', `--database=${database}`]);
if (!indexes.some(i => i.name.includes('/collectionGroups/ai_meeting_team_audit/') && i.fields[0]?.fieldPath === 'team' && i.fields[1]?.fieldPath === 'at' && i.fields[1]?.order === 'DESCENDING')) gcloud(['firestore', 'indexes', 'composite', 'create', `--database=${database}`, '--collection-group=ai_meeting_team_audit', '--field-config=field-path=team,order=ascending', '--field-config=field-path=at,order=descending', '--async']);
console.log(JSON.stringify({ profile: 'team-tasks-3m-v1', configured: true, database, note: 'The readiness check must wait until TTL and indexes are ACTIVE/READY. A backup schedule is not proof of a completed backup.' }));
