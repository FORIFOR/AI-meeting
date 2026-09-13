import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const serverRequire = createRequire(new URL('../../services/token-broker/package.json', import.meta.url));
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { initializeApp, applicationDefault } = serverRequire('firebase-admin/app');
const { getAuth } = serverRequire('firebase-admin/auth');
const { Firestore } = serverRequire('@google-cloud/firestore');
const puppeteer = webRequire('puppeteer-core');
const project = process.env.GOOGLE_CLOUD_PROJECT || 'gen-lang-client-0307428960';
const broker = process.env.TEAM_BROKER_URL || 'https://team-check---ai-meeting-broker-pdygkns5gq-an.a.run.app';
const appUrl = process.env.APP_URL || 'http://127.0.0.1:5180/';
const directory = process.env.TEAM_QA_DIR || 'artifacts/team-cloud';
const live = process.env.TEAM_LIVE === '1';
const auth = getAuth(initializeApp({ projectId: project, credential: applicationDefault() }, `team-qa-${Date.now()}`));
const db = new Firestore({ projectId: project, databaseId: 'ai-meeting-teams' });
const config = await (await fetch('https://ai-meeting.web.app/__/firebase/init.json')).json() as any;
const suffix = randomBytes(8).toString('hex');
const accounts = ['owner', 'member', 'outsider'].map(role => ({ role, uid: `team-qa-${suffix}-${role}`, email: `team-qa-${suffix}-${role}@example.invalid`, password: randomBytes(24).toString('base64url'), token: '' }));
const created: string[] = [], teams: string[] = [];
const deployment = JSON.parse(execFileSync('gcloud', ['run', 'services', 'describe', 'ai-meeting-broker', '--region=asia-northeast1', `--project=${project}`, '--format=json'], { encoding: 'utf8' }));
const backendRevision = deployment.status.traffic.find(t => t.url === broker)?.revisionName ?? deployment.status.traffic.find(t => t.percent === 100)?.revisionName;
const deployedRevision = JSON.parse(execFileSync('gcloud', ['run', 'revisions', 'describe', backendRevision, '--region=asia-northeast1', `--project=${project}`, '--format=json'], { encoding: 'utf8' }));
const report: any = { backendRevision, backendImageDigest: deployedRevision.status.imageDigest, schema: 'rcai.team-cloud-verification.v1', profile: 'team-tasks-3m-v1', sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), broker, appUrl, inputSource: 'synthetic', checks: {}, liveRequested: live, success: false };
let browser: any;
await mkdir(directory, { recursive: true });
async function api(team: string, body: any, account = accounts[0]!, expected = 200) {
  const response = await fetch(`${broker}/api/team/${team}`, { method: 'POST', headers: { Authorization: `Bearer ${account.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const result = await response.json() as any;
  assert.equal(response.status, expected, `${body.action ?? 'create'} returned ${response.status}: ${result.error ?? 'ok'}`);
  return result;
}
async function pageFor(account: typeof accounts[number], hash: string) {
  const context = await browser.createBrowserContext(), page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', request => request.url().endsWith('/__/firebase/init.json') ? request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }) : request.continue());
  await page.goto(`${appUrl}${hash}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.hosted-account button'); await page.click('.hosted-account button');
  await page.locator('.hosted-account input[type=email]').fill(account.email);
  await page.locator('.hosted-account input[type=password]').fill(account.password);
  await page.click('.hosted-account form .btn--primary');
  await page.waitForSelector('.team-entry', { timeout: 20000 });
  return page;
}
async function reopen(page: any) { await page.reload({ waitUntil: 'networkidle2' }); await page.waitForSelector('.team-entry'); await page.click('.team-entry form:nth-child(2) button'); await page.waitForSelector('.team-overview'); }
try {
  for (const account of accounts) {
    await auth.createUser({ ...Object.fromEntries(['uid', 'email', 'password'].map(k => [k, account[k]])), emailVerified: true }); created.push(account.uid);
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${config.apiKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: account.email, password: account.password, returnSecureToken: true }) });
    const data = await response.json() as any; assert.ok(response.ok && data.idToken, 'synthetic account sign-in'); account.token = data.idToken;
  }
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const owner = await pageFor(accounts[0]!, '#team');
  await owner.locator('.team-entry form:first-child input').fill('QA synthetic team');
  await owner.click('.team-entry form:first-child button'); await owner.waitForSelector('.team-overview', { timeout: 20000 });
  const team = await owner.evaluate(() => location.hash.split('/')[1]); assert.match(team, /^team-[a-f0-9]{24}$/); teams.push(team);
  const other = await api('create', { name: 'QA isolated team' }, accounts[2]); teams.push(other.team);
  await owner.waitForFunction(() => document.querySelector<HTMLInputElement>('.task-add input')?.disabled === false);
  await owner.locator('.task-add input').fill('QA 見積書を送る');
  await owner.click('.task-add button'); await owner.waitForSelector('.task-card');
  assert.match((await api(team, { action: 'read' })).tasks[0].title, /QA 見積書/);
  report.checks.browserSaveToCloud = true;
  await api(team, { action: 'read', uid: accounts[0]!.uid, role: 'admin' }, accounts[2], 403);
  assert.deepEqual((await api(other.team, { action: 'read' }, accounts[2])).tasks, []);
  report.checks.crossTenantDenied = true;
  await owner.click('.team-admin summary');
  await owner.locator('.team-admin form input:not([type=email])').fill('QA colleague');
  await owner.locator('.team-admin input[type=email]').fill(accounts[1]!.email);
  await owner.click('.team-admin form button'); await owner.waitForSelector('.team-admin textarea');
  const invitation = await owner.$eval('.team-admin textarea', el => el.value);
  const member = await pageFor(accounts[1]!, `#${invitation.split('#')[1]}`);
  await member.click('.team-entry form:nth-child(2) button'); await member.waitForSelector('.task-card', { timeout: 20000 });
  assert.equal(await member.$('.team-admin'), null); report.checks.emailBoundInvitation = true;
  await member.click('.task-check'); await member.waitForFunction(() => document.querySelector('.tasks-status')?.textContent?.includes('保存'));
  await reopen(owner); await owner.click('.task-filter button:nth-child(3)');
  await owner.waitForSelector('.task-card--done'); report.checks.crossAccountSync = true;
  // A transport fault is injected only for a single task write; real datastore checks remain separate.
  owner.removeAllListeners('request'); let injected = false;
  owner.on('request', request => {
    if (request.url().endsWith('/__/firebase/init.json')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
    if (!injected && request.url() === `${broker}/api/team/${team}` && request.postData()?.includes('"action":"replace"')) { injected = true; return request.respond({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': new URL(appUrl).origin }, body: JSON.stringify({ message: 'QA simulated network failure' }) }); }
    return request.continue();
  });
  await owner.locator('.task-add input').fill('QA must not be saved'); await owner.click('.task-add button'); await owner.waitForSelector('.tasks-page [role=alert]');
  assert.ok(injected); assert.ok(!(await api(team, { action: 'read' })).tasks.some(t => t.title === 'QA must not be saved'));
  assert.ok(!(await owner.$eval('.tasks-status', el => el.textContent)).includes('保存しました')); report.checks.noFalseSaveOnTransportFailure = true;
  if (live) {
    const wav = await readFile('artifacts/hosted-access/task.wav');
    member.removeAllListeners('request'); member.on('request', request => {
      if (request.url().endsWith('/__/firebase/init.json')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
      if (request.url().endsWith('/qa-input.wav')) return request.respond({ status: 200, contentType: 'audio/wav', body: wav });
      return request.continue();
    });
    await member.evaluate(() => { (window as any).__qaTracks = []; navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), source = context.createBufferSource(); source.buffer = await context.decodeAudioData(await (await fetch('/qa-input.wav')).arrayBuffer());
      const destination = context.createMediaStreamDestination(); source.connect(destination); source.start(); await context.resume();
      (window as any).__qaTracks.push(...destination.stream.getTracks()); return destination.stream;
    }; });
    const cdp = await member.createCDPSession(); await cdp.send('Network.enable'); let audioMessages = 0, toolCalls = 0, terminal = '';
    cdp.on('Network.webSocketFrameReceived', event => { try { const data = JSON.parse(event.response.payloadData); if (data.serverContent?.modelTurn?.parts?.some(p => p.inlineData?.data)) audioMessages++; if (data.toolCall) toolCalls++; } catch {} });
    await member.evaluate(() => { const Native = window.WebSocket; window.WebSocket = class extends Native { constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); this.addEventListener('close', e => { (window as any).__qaCloseReason = e.reason; }); } } as typeof WebSocket; });
    await member.click('.team-consent input'); await member.click('.tasks-summary button'); await member.waitForSelector('.session');
    await member.waitForFunction(() => !document.querySelector('.stage__loading'), { timeout: 45000 });
    const deadline = Date.now() + 65000;
    while (Date.now() < deadline) {
      const proposal = await member.$('.task-review');
      if (proposal) { const text = await proposal.evaluate(e => e.textContent); assert.ok(text.includes('資料確認') && /9.?月.?15.?日/.test(text), 'Only the authored fixture can be confirmed'); await member.click('.task-review button'); report.fixtureProposalConfirmed = true; }
      if (toolCalls > 0 && audioMessages > 0 && (await api(team, { action: 'read' })).tasks.length > 1) break; await new Promise(r => setTimeout(r, 1000)); }
    assert.ok(toolCalls > 0 && audioMessages > 0, 'real Vertex tool call and audio response');
    assert.ok((await api(team, { action: 'read' })).tasks.length > 1, 'spoken task persisted in the team workspace');
    report.checks.realVoiceToTeamTask = true;
    const members = await api(team, { action: 'read' }); const colleague = members.members.find(m => m.role === 'member'); assert.ok(colleague);
    const revokedAt = Date.now(); await api(team, { action: 'revoke', member: colleague.id });
    await member.waitForFunction(() => (window as any).__qaCloseReason === 'HOSTED_TEAM_REVOKED', { timeout: 23000 });
    terminal = await member.evaluate(() => (window as any).__qaCloseReason);
    await member.waitForFunction(() => (window as any).__qaTracks.every(t => t.readyState === 'ended'), { timeout: 10000 });
    report.live = { inputSource: 'synthetic', audioMessages, toolCalls, terminal, revokeToDisconnectMs: Date.now() - revokedAt, microphoneReleased: true };
    report.checks.activeVoiceRevoked = true;
  } else {
    const members = await api(team, { action: 'read' });
    await api(team, { action: 'revoke', member: members.members.find(m => m.role === 'member').id });
  }
  await api(team, { action: 'read' }, accounts[1], 403); report.checks.revokedMemberDenied = true;
  const snapshot = await api(team, { action: 'read' });
  const calls = await Promise.all([0, 1].map(n => fetch(`${broker}/api/team/${team}`, { method: 'POST', headers: { Authorization: `Bearer ${accounts[0]!.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'replace', revision: snapshot.revision, tasks: [{ id: 'qa-final', title: `QA final ${n}`, status: 'pending' }] }) })));
  assert.deepEqual(calls.map(r => r.status).sort(), [200, 409]); report.checks.concurrentWriteConflict = true;
  const before = await api(team, { action: 'read' });
  const ref = db.collection('ai_meeting_team_workspaces').doc(team), stored = await ref.get();
  const erased = await api(team, { action: 'erase', revision: before.revision });
  assert.equal((await ref.get()).exists, false);
  const recovered = await db.runTransaction(tx => tx.get(ref), { readOnly: true, readTime: stored.updateTime });
  assert.ok(recovered.exists); assert.deepEqual(recovered.data().tasks, before.tasks);
  await api(team, { action: 'replace', revision: erased.revision, tasks: recovered.data().tasks });
  assert.deepEqual((await api(team, { action: 'read' })).tasks, before.tasks);
  report.checks.historicalReadAndRestore = true;
  const audited = await api(team, { action: 'audit' });
  assert.ok(audited.audit.some(a => a.action === 'erase')); assert.ok(!JSON.stringify(audited.audit).includes('QA final'));
  report.checks.metadataOnlyAudit = true;
  const documentUrl = `https://firestore.googleapis.com/v1/projects/${project}/databases/ai-meeting-teams/documents/ai_meeting_team_workspaces/${team}`;
  for (const headers of [{}, { Authorization: `Bearer ${accounts[0]!.token}` }]) { const denied = await fetch(documentUrl, { headers }); assert.ok([401, 403].includes(denied.status)); }
  report.checks.directDatabaseReadDenied = true;
  await reopen(owner); await owner.waitForFunction(() => document.querySelector<HTMLInputElement>('.task-add input')?.disabled === false); await owner.screenshot({ path: `${directory}/desktop.png`, fullPage: true });
  await owner.setViewport({ width: 390, height: 844 }); await owner.screenshot({ path: `${directory}/mobile.png`, fullPage: true });
  assert.equal(await owner.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false); report.checks.mobileNoOverflow = true;
  for (const [index, t] of teams.entries()) { const account = index === 0 ? accounts[0] : accounts[2]; const current = await api(t, { action: 'read' }, account); await api(t, { action: 'close', revision: current.revision }, account); await api(t, { action: 'read' }, account, 403); }
  report.checks.teamClosure = true; report.success = true;
} catch (error) { if (browser) report.visibleErrors = await Promise.all((await browser.pages()).map(p => p.$$eval('.team-page [role=alert], .hosted-account [role=alert]', elements => elements.map(e => e.textContent)).catch(() => []))); report.failure = error instanceof Error ? error.message : 'verification failed'; process.exitCode = 1; }
finally {
  await browser?.close();
  const cleanup: boolean[] = [];
  for (const uid of created) cleanup.push(await auth.deleteUser(uid).then(() => true, () => false));
  for (const team of teams) {
    // Delete only identifiers returned for the synthetic accounts created by this run. No counter resets.
    await db.collection('ai_meeting_team_workspaces').doc(team).delete(); await db.collection('ai_meeting_teams').doc(team).delete();
    const rows = await db.collection('ai_meeting_team_audit').where('team', '==', team).get();
    for (const row of rows.docs) await row.ref.delete();
  }
  report.cleanup = { syntheticAccountsDeleted: cleanup.every(Boolean), syntheticTeamsDeleted: teams.length, capacityCountersPreserved: true };
  report.success &&= cleanup.every(Boolean); report.finishedAt = new Date().toISOString();
  await mkdir(`${directory}/attempts`, { recursive: true });
  await writeFile(`${directory}/attempts/${report.startedAt.replaceAll(':', '-')}.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(`${directory}/verification.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report)); await db.terminate();
}
