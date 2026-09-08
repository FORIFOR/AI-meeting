/** Read-only Hosted check. Never send a self-hosted key to another origin. */
const base = process.env.HOSTED_ATTENDEE_API_BASE_URL ?? 'https://app.attendee.dev';
const key = process.env.HOSTED_ATTENDEE_API_KEY;
if (new URL(base).origin !== 'https://app.attendee.dev' || !key) {
  console.log('BLOCKED: dedicated HOSTED_ATTENDEE_API_KEY is required; local .env credentials are not reused.');
  process.exit(2);
}
try {
  const response = await fetch('https://app.attendee.dev/api/v1/bots', { headers: { Authorization: `Token ${key}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  console.log(JSON.stringify({ check: 'hosted_bot_list_auth', status: response.ok ? 'PASS' : 'FAIL', httpStatus: response.status, meetingCompatibility: 'UNVERIFIED' }));
  // Do not print bot identifiers, meeting URLs, credentials or response bodies.
  process.exitCode = response.ok ? 0 : 1;
} catch { console.log('BLOCKED: hosted API network request failed'); process.exitCode = 2; }
