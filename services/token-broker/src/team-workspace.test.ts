import { describe, expect, it } from 'vitest';
import { TeamWorkspaceService, TeamError, createTeamRoutes, teamHash, TEAM_CONSENT, type TeamState, type TeamStore, type TeamAudit } from './team-workspace.js';
import { HostedAccess, type HostedStore, type HostedUsage } from './hosted-access.js';
class Store implements TeamStore {
  data = new Map<string, TeamState>(); rows: TeamAudit[] = []; offline = false; count = 0;
  private queue: Promise<unknown> = Promise.resolve();
  change<T>(team: string, fn: (s: TeamState) => T, create = false): Promise<T> {
    const result = this.queue.catch(() => {}).then(() => {
      if (this.offline) throw new Error('fixture offline');
      const before = this.data.get(team), s = structuredClone(before ?? { policy: null, workspace: null, audit: [] });
      s.audit = []; const result = fn(s);
      if (create && !before?.policy && s.policy) { if (this.count >= 10) throw new TeamError(429, 'TEAM_CAPACITY', 'full'); this.count++; }
      this.rows.push(...s.audit); s.audit = []; this.data.set(team, s); return result;
    }); this.queue = result; return result;
  }
  async ping() { if (this.offline) throw new Error('offline'); }
  async audit(team: string) { if (this.offline) throw new Error('offline'); return this.rows.filter(r => r.team === team).reverse().slice(0, 100); }
}
class Usage implements HostedStore {
  data: HostedUsage = { grants: [] }; offline = false;
  async change<T>(_month: string, fn: (s: HostedUsage) => T) { if (this.offline) throw new Error('offline'); const data = structuredClone(this.data); const result = fn(data); this.data = data; return result; }
}
const env = { RCAI_TEAM_WORKSPACES: '1', RCAI_TEAM_FIRESTORE_DATABASE: 'team-test', RCAI_PUBLIC_DEMO_ONLY: '1', RCAI_HOSTED_ACCESS: '1', RCAI_HOSTED_FIRESTORE_DATABASE: 'test', RCAI_HOSTED_MONTHLY_SESSIONS: '30', RCAI_HOSTED_USER_DAILY_SESSIONS: '1', GEMINI_BACKEND: 'vertex' as const, GOOGLE_CLOUD_PROJECT: 'test', RECALL_BOT_PAGE_URL: 'https://app.example' };
const auth = (user = 'owner') => `Bearer signed-synthetic-test-${user}`;
const task = { id: 'task-1', title: '見積書を送る', status: 'pending' as const, due: '明日15時' };
function fixture() {
  const store = new Store(), usage = new Usage(); let time = Date.UTC(2026, 8, 13);
  const hosted = new HostedAccess(env, { store: usage, now: () => time, verify: async token => {
    if (token.endsWith('invalid')) throw new Error('invalid');
    const uid = token.replace('signed-synthetic-test-', '');
    return { uid, email: `${uid}@example.invalid`, email_verified: uid !== 'unverified', firebase: { sign_in_provider: 'password' } };
  } });
  const service = new TeamWorkspaceService(env, hosted, { store, now: () => time });
  const request = (team: string, body: Record<string, unknown>, user = 'owner') => service.request(team, auth(user), body) as Promise<any>;
  return { store, usage, hosted, service, request, advance: (ms: number) => { time += ms; } };
}
describe('team-tasks-3m-v1 isolation and lifecycle', () => {
  it('creates idempotently for one verified owner and refuses unverified or invalid identities', async () => {
    const f = fixture();
    for (const user of ['invalid', 'unverified']) await expect(f.service.create(auth(user), 'Team')).rejects.toHaveProperty('status');
    await expect(f.service.create(undefined, 'Team')).rejects.toHaveProperty('status', 401);
    const a = await f.service.create(auth(), 'Team'), b = await f.service.create(auth(), 'Other');
    expect(a).toEqual(b); expect(f.store.count).toBe(1);
    expect(await f.request(a.team, { action: 'read' })).toMatchObject({ name: 'Team', role: 'admin', tasks: [] });
  });
  it('does not allow cross-tenant access, forged roles or caller-supplied identities', async () => {
    const f = fixture(), a = await f.service.create(auth(), 'A'), b = await f.service.create(auth('other'), 'B');
    await f.request(a.team, { action: 'replace', revision: null, tasks: [task] });
    await expect(f.request(a.team, { action: 'read', uid: 'owner', role: 'admin' }, 'other')).rejects.toMatchObject({ status: 403 });
    await expect(f.request(b.team, { action: 'erase', revision: null })).rejects.toMatchObject({ status: 403 });
    expect((await f.request(b.team, { action: 'read' }, 'other')).tasks).toEqual([]);
  });
  it('allows exactly one winner during concurrent replacement across service instances', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const second = new TeamWorkspaceService(env, f.hosted, { store: f.store });
    const results = await Promise.allSettled([f.request(team, { action: 'replace', revision: null, tasks: [task] }), second.request(team, auth(), { action: 'replace', revision: null, tasks: [{ ...task, title: 'other' }] })]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'TEAM_CONFLICT' } });
    expect(f.store.rows.filter(r => r.action === 'replace')).toHaveLength(1);
  });
  it('rejects invalid tasks without changing the revision, quota or audit trail', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const before = structuredClone(f.store.data.get(team));
    for (const tasks of [[{ ...task, status: 'approved' }], Array(101).fill(task), [{ ...task, title: '' }], [task, task]]) await expect(f.request(team, { action: 'replace', revision: null, tasks })).rejects.toMatchObject({ code: 'TEAM_TASKS' });
    expect(f.store.data.get(team)).toEqual(before);
  });
  it('binds one-use invitations to the verified email and prevents privilege escalation', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const invite = await f.request(team, { action: 'invite', email: 'Member@example.invalid' });
    await expect(f.request(team, { action: 'join', token: invite.invitationToken }, 'other')).rejects.toMatchObject({ status: 403 });
    const joined = await f.request(team, { action: 'join', token: invite.invitationToken }, 'member');
    expect(joined.role).toBe('member'); expect(joined.members).toEqual([]);
    await expect(f.request(team, { action: 'join', token: invite.invitationToken }, 'member')).rejects.toMatchObject({ status: 403 });
    for (const action of ['invite', 'erase', 'close', 'audit', 'revoke']) await expect(f.request(team, { action, revision: null }, 'member')).rejects.toMatchObject({ status: 403 });
    await f.request(team, { action: 'replace', tasks: [task], revision: null }, 'member');
    expect((await f.request(team, { action: 'read' })).tasks).toHaveLength(1);
  });
  it('revokes membership and denies both stored tasks and an active relay guard', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const { invitationToken } = await f.request(team, { action: 'invite', email: 'member@example.invalid' });
    await f.request(team, { action: 'join', token: invitationToken }, 'member');
    expect(await f.service.allowed(team, teamHash('member'))).toBe(true);
    await f.request(team, { action: 'revoke', member: teamHash('member') });
    expect(await f.service.allowed(team, teamHash('member'))).toBe(false);
    await expect(f.request(team, { action: 'read' }, 'member')).rejects.toMatchObject({ status: 403 });
  });
  it('expires invites without TTL cleanup and limits reserved membership slots', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const { invitationToken } = await f.request(team, { action: 'invite', email: 'member@example.invalid' });
    f.advance(2 * 86400000);
    await expect(f.request(team, { action: 'join', token: invitationToken }, 'member')).rejects.toMatchObject({ status: 403 });
    for (let i = 0; i < 4; i++) await f.request(team, { action: 'invite', email: `member${i}@example.invalid` });
    await expect(f.request(team, { action: 'invite', email: 'extra@example.invalid' })).rejects.toMatchObject({ code: 'TEAM_MEMBERS' });
  });
  it('erases content, preserves metadata-only audit, and rejects stale resurrection after restore', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    const saved = await f.request(team, { action: 'replace', revision: null, tasks: [task] });
    const erased = await f.request(team, { action: 'erase', revision: saved.revision });
    expect((await f.request(team, { action: 'read' })).tasks).toEqual([]);
    const restored = await f.request(team, { action: 'replace', revision: erased.revision, tasks: saved.tasks });
    await expect(f.request(team, { action: 'replace', revision: null, tasks: saved.tasks })).rejects.toMatchObject({ status: 409 });
    expect(restored.tasks).toMatchObject([task]); expect(restored.revision).not.toBe(saved.revision);
    await expect(f.request(team, { action: 'replace', revision: saved.revision, tasks: [] })).rejects.toMatchObject({ status: 409 });
    const audit = await f.request(team, { action: 'audit' });
    expect(JSON.stringify(audit.audit)).not.toContain(task.title); expect(JSON.stringify(f.store.rows)).not.toContain('@');
    expect(audit.audit.some((a: any) => a.action === 'erase')).toBe(true);
  });
  it('closes the team irreversibly and does not reset quotas by recreating it', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    await f.request(team, { action: 'close', revision: null });
    expect(await f.service.allowed(team, teamHash('owner'))).toBe(false);
    await expect(f.service.create(auth(), 'A')).rejects.toMatchObject({ status: 403 });
    expect(f.store.data.get(team)?.workspace).toBeNull(); expect(f.store.data.get(team)?.policy?.members).toEqual({});
  });
  it('denies expired teams immediately even before Firestore TTL deletion', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    await f.request(team, { action: 'replace', revision: null, tasks: [task] });
    f.advance(30 * 86400000);
    await expect(f.request(team, { action: 'read' })).rejects.toMatchObject({ status: 403 });
    expect(await f.service.allowed(team, teamHash('owner'))).toBe(false);
  });
  it('reserves voice only after consent and keeps a trusted team binding in the single-use grant', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    await expect(f.request(team, { action: 'voice', consent: 'old' })).rejects.toMatchObject({ code: 'TEAM_CONSENT' });
    expect(f.usage.data.grants).toHaveLength(0);
    const ticket = await f.request(team, { action: 'voice', consent: TEAM_CONSENT, team: 'forged' });
    expect(await f.hosted.consume(ticket.token)).toMatchObject({ seconds: 180, team: { id: team, actor: teamHash('owner') } });
    expect(await f.hosted.consume(ticket.token)).toBeNull();
    await expect(f.request(team, { action: 'voice', consent: TEAM_CONSENT })).rejects.toMatchObject({ code: 'DAILY_LIMIT_REACHED' });
    expect((await f.request(team, { action: 'read' })).voiceReservations).toBe(2);
  });
  it('fails closed during datastore outages without marking a write successful', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A'); f.store.offline = true;
    await expect(f.request(team, { action: 'replace', revision: null, tasks: [task] })).rejects.toMatchObject({ status: 503 });
    expect(await f.service.allowed(team, teamHash('owner'))).toBe(false);
    expect(f.store.data.get(team)?.workspace).toBeNull();
  });
  it('does not bypass total voice and daily storage quotas', async () => {
    const f = fixture(), { team } = await f.service.create(auth(), 'A');
    f.store.data.get(team)!.policy!.voiceReservations = 20;
    await expect(f.request(team, { action: 'voice', consent: TEAM_CONSENT })).rejects.toMatchObject({ code: 'TEAM_VOICE_LIMIT' });
    f.store.data.get(team)!.policy!.usage.operations = 1000;
    await expect(f.request(team, { action: 'read' })).rejects.toMatchObject({ code: 'TEAM_DAILY_LIMIT' });
    expect(f.usage.data.grants).toHaveLength(0);
  });
  it('checks actual storage readiness and expires its short shared cache', async () => {
    const f = fixture(); expect(await f.service.ready()).toBe(true);
    f.store.offline = true; expect(await f.service.ready()).toBe(true);
    f.advance(60001); expect(await f.service.ready()).toBe(false);
    const disabled = new TeamWorkspaceService({ ...env, RCAI_TEAM_WORKSPACES: '0' }, f.hosted, { store: f.store });
    expect(await disabled.ready()).toBe(false);
  });
  it('limits automatic provisioning to ten lifetime launch slots', async () => {
    const f = fixture(); for (let i = 0; i < 10; i++) await f.service.create(auth(`u${i}`), 'A');
    await expect(f.service.create(auth('extra'), 'A')).rejects.toMatchObject({ code: 'TEAM_CAPACITY' });
  });
  it('rejects untrusted origins, missing identity, oversized or malformed input through the HTTP routes', async () => {
    const f = fixture(), app = createTeamRoutes(env, f.service);
    const send = (value: string, headers: Record<string, string> = {}) => app.request('/create', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: auth(), ...headers }, body: value });
    expect((await send('{"name":"A"}', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await send('{"name":"A"}', { authorization: '' })).status).toBe(401);
    expect((await send('{')).status).toBe(400);
    expect((await send('[]')).status).toBe(400);
    expect((await send(' '.repeat(100001))).status).toBe(413);
    const good = await send('{"name":"A"}', { origin: 'https://app.example' });
    expect(good.status).toBe(200); expect(good.headers.get('cache-control')).toBe('no-store');
  });
});
