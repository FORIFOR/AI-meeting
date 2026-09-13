import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ auth: { currentUser: { uid: 'u1', emailVerified: true, getIdToken: async () => 'signed-fixture-token' } } }));
vi.mock('../api/hostedAuth.js', () => ({ hostedAuth: async () => fixture.auth, hostedBrokerAllowed: (url: string) => url === 'https://broker.example' }));
import { TeamTaskWorkspace, teamRequest } from './teamWorkspace.js';
const team = 'team-aaaaaaaaaaaaaaaaaaaaaaaa';
beforeEach(() => { fixture.auth.currentUser.uid = 'u1'; });
afterEach(() => { vi.unstubAllGlobals(); });
it('requires server acknowledgement, sends an expected revision and never uses local storage', async () => {
  let tasks: any[] = [], revision = 'r0';
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(init?.redirect).toBe('error'); expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer signed-fixture-token');
    if (body.action === 'replace') { expect(body.revision).toBe(revision); tasks = body.tasks; revision = 'r1'; }
    return Response.json({ tasks, revision });
  });
  vi.stubGlobal('fetch', request); vi.stubGlobal('indexedDB', { open: () => { throw new Error('personal storage must not be used'); } });
  const workspace = new TeamTaskWorkspace('https://broker.example', 'u1', team);
  await workspace.add('見積書を送る', '明日15時');
  expect(await workspace.read()).toMatchObject([{ title: '見積書を送る', due: '明日15時' }]);
  expect(request).toHaveBeenCalledTimes(3);
});
it('does not turn a failed or conflicting write into local success and can recover after a reload', async () => {
  let status = 503;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => JSON.parse(String(init.body)).action === 'read' ? Response.json({ revision: 'r0', tasks: [] }) : Response.json({ message: '保存を確認できませんでした。' }, { status }));
  const workspace = new TeamTaskWorkspace('https://broker.example', 'u1', team);
  await expect(workspace.add('A', '')).rejects.toHaveProperty('status', 503);
  expect(await workspace.read()).toEqual([]);
  status = 409;
  await expect(workspace.add('A', '')).rejects.toHaveProperty('status', 409);
});
it('discards in-flight responses when identity changes or access is closed', async () => {
  let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal('fetch', () => new Promise<Response>(resolve => { finish = resolve; }));
  const workspace = new TeamTaskWorkspace('https://broker.example', 'u1', team);
  const pending = workspace.read(); await vi.waitFor(() => expect(finish).toBeDefined());
  fixture.auth.currentUser.uid = 'u2'; finish!(Response.json({ tasks: [{ id: 't1', title: 'private', status: 'pending' }] }));
  await expect(pending).rejects.toHaveProperty('status', 401);
  workspace.close(); await expect(workspace.read()).rejects.toHaveProperty('status', 403);
});
it('refuses to send the identity token to an arbitrary broker or a different signed-in account', async () => {
  const request = vi.fn(); vi.stubGlobal('fetch', request);
  await expect(teamRequest('https://evil.example', 'u1', team, {})).rejects.toThrow();
  await expect(teamRequest('https://broker.example', 'u2', team, {})).rejects.toHaveProperty('status', 401);
  expect(request).not.toHaveBeenCalled();
});
