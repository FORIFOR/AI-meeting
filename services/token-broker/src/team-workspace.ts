import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Firestore, Timestamp } from '@google-cloud/firestore';
import { Hono } from 'hono';
import { validateTasks, type ConversationTask } from '@rcai/conversation-core';
import { HostedAccess, HostedAccessError, type HostedIdentity } from './hosted-access.js';
import type { BrokerEnv } from './env.js';

export const TEAM_CONSENT = 'team-voice-2026-09-13';
export const TEAM_COLLECTIONS = { teams: 'ai_meeting_teams', workspaces: 'ai_meeting_team_workspaces', audit: 'ai_meeting_team_audit', capacity: 'ai_meeting_team_capacity' };
const DAY = 86_400_000;
export const teamHash = (s: string) => createHash('sha256').update(s).digest('hex');
export interface TeamPolicy {
  revision: string | null; name: string; owner: string; members: Record<string, 'admin' | 'member'>; names: Record<string, string>;
  active: boolean; expiresAt: number;
  invites: { hash: string; emailHash: string; name: string; expiresAt: number }[];
  usage: { day: string; operations: number; voice: number }; voiceReservations: number;
}
export interface TeamData { revision: string; tasks: ConversationTask[]; updatedAt: number; expiresAt: number }
export interface TeamAudit { team: string; actor: string; action: string; at: number; count: number; expiresAt: number }
export interface TeamState { policy: TeamPolicy | null; workspace: TeamData | null; audit: TeamAudit[] }
export interface TeamStore {
  change<T>(team: string, fn: (s: TeamState) => T, create?: boolean): Promise<T>;
  audit(team: string): Promise<TeamAudit[]>;
}
export class TeamError extends Error { constructor(readonly status: 400 | 403 | 409 | 413 | 429 | 503, readonly code: string, message: string) { super(message); } }
const denied = () => new TeamError(403, 'TEAM_UNAVAILABLE', 'このチームを利用できません。招待・利用期限・アクセス権を確認してください。');

/** Policy, tasks, quota and audit are committed together. Caller never chooses another document path. */
export class FirestoreTeamStore implements TeamStore {
  readonly db: Firestore;
  constructor(project: string, databaseId: string) { this.db = new Firestore({ projectId: project, databaseId }); }
  async change<T>(team: string, fn: (s: TeamState) => T, create = false): Promise<T> {
    return this.db.runTransaction(async tx => {
      const p = this.db.collection(TEAM_COLLECTIONS.teams).doc(team);
      const w = this.db.collection(TEAM_COLLECTIONS.workspaces).doc(team);
      const capacity = this.db.collection(TEAM_COLLECTIONS.capacity).doc('launch');
      const [ps, ws, cs] = await Promise.all([tx.get(p), tx.get(w), create ? tx.get(capacity) : Promise.resolve(null)]);
      const raw = ws.data();
      const state: TeamState = { policy: ps.exists ? { ...ps.data(), expiresAt: ps.data()!.expiresAt.toMillis() } as TeamPolicy : null, workspace: raw ? { ...raw, expiresAt: raw.expiresAt.toMillis() } as TeamData : null, audit: [] };
      const beforePolicy = JSON.stringify(state.policy), beforeWorkspace = JSON.stringify(state.workspace);
      const result = fn(state);
      if (create && !ps.exists && state.policy) {
        const count = cs?.exists ? cs.data()?.count : 0;
        if (!Number.isInteger(count) || count < 0) throw new Error('invalid team capacity');
        // No automatic resets, no unlimited account-created storage spend.
        if (count >= 10) throw new TeamError(429, 'TEAM_CAPACITY', '限定導入の受付枠に達しました。既存チームは引き続き利用できます。');
        tx.set(capacity, { count: count + 1 });
      }
      if (beforePolicy !== JSON.stringify(state.policy)) {
        if (!state.policy) throw new Error('team tombstones must be retained');
        tx.set(p, { ...state.policy, expiresAt: Timestamp.fromMillis(state.policy.expiresAt) });
      }
      if (beforeWorkspace !== JSON.stringify(state.workspace)) {
        if (state.workspace) tx.set(w, { ...state.workspace, expiresAt: Timestamp.fromMillis(state.workspace.expiresAt) });
        else tx.delete(w);
      }
      for (const entry of state.audit) tx.create(this.db.collection(TEAM_COLLECTIONS.audit).doc(), { ...entry, expiresAt: Timestamp.fromMillis(entry.expiresAt) });
      return result;
    }, { maxAttempts: 5 });
  }
  async audit(team: string) {
    const rows = await this.db.collection(TEAM_COLLECTIONS.audit).where('team', '==', team).orderBy('at', 'desc').limit(100).get();
    return rows.docs.map(d => ({ ...d.data(), expiresAt: d.data().expiresAt.toMillis() }) as TeamAudit);
  }
}

export class TeamWorkspaceService {
  readonly enabled: boolean;
  private readonly store?: TeamStore;
  constructor(private readonly env: BrokerEnv, private readonly hosted: HostedAccess, private readonly deps: { store?: TeamStore; now?: () => number } = {}) {
    this.enabled = env.RCAI_TEAM_WORKSPACES === '1' && !!env.RCAI_TEAM_FIRESTORE_DATABASE && hosted.policy.enabled;
    this.store = deps.store ?? (this.enabled ? new FirestoreTeamStore(env.GOOGLE_CLOUD_PROJECT!, env.RCAI_TEAM_FIRESTORE_DATABASE!) : undefined);
  }
  private now() { return (this.deps.now ?? Date.now)(); }
  private async transact<T>(team: string, fn: (s: TeamState) => T, create = false): Promise<T> {
    if (!this.enabled) throw new TeamError(503, 'TEAM_DISABLED', 'チームの利用は現在停止しています。');
    if (!/^team-[a-f0-9]{24}$/.test(team)) throw denied();
    try { return await this.store!.change(team, fn, create); }
    catch (e) { if (e instanceof TeamError) throw e; throw new TeamError(503, 'TEAM_STORE_UNAVAILABLE', 'チームの保存先に接続できませんでした。変更は確認できていません。読み直してから再試行してください。'); }
  }
  private member(state: TeamState, actor: string, admin = false) {
    const p = state.policy;
    if (!p || !p.active || !Number.isFinite(p.expiresAt) || p.expiresAt <= this.now() || !['admin', 'member'].includes(p.members?.[actor] ?? '') || (admin && p.members[actor] !== 'admin')) throw denied();
    if ((p.revision !== null && (typeof p.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(p.revision))) || !Array.isArray(p.invites) || !Number.isInteger(p.voiceReservations) || p.voiceReservations < 0 || !p.usage || !Number.isInteger(p.usage.operations) || p.usage.operations < 0 || !Number.isInteger(p.usage.voice) || p.usage.voice < 0) throw new Error('invalid team policy');
    return p;
  }
  private record(s: TeamState, team: string, actor: string, action: string, count = 0) {
    const p = s.policy!, day = new Date(this.now()).toISOString().slice(0, 10);
    if (p.usage.day !== day) p.usage = { day, operations: 0, voice: 0 };
    if (p.usage.operations >= 1000) throw new TeamError(429, 'TEAM_DAILY_LIMIT', '本日のチーム操作上限に達しました。');
    p.usage.operations++;
    // Read polling is counted but creates no permanent access-history amplification.
    if (action !== 'read') s.audit.push({ team, actor, action, at: this.now(), count, expiresAt: this.now() + 90 * DAY });
  }
  async create(authorization: string | undefined, name: unknown) {
    const identity = await this.hosted.identity(authorization), actor = teamHash(identity.uid), team = `team-${actor.slice(0, 24)}`;
    if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new TeamError(400, 'TEAM_NAME', 'チーム名は60文字以内で入力してください。');
    return this.transact(team, s => {
      if (s.policy) { this.member(s, actor, true); return { team }; }
      s.policy = { revision: null, name: name.trim(), owner: actor, members: { [actor]: 'admin' }, names: { [actor]: '管理者' }, active: true, expiresAt: this.now() + 30 * DAY, invites: [], usage: { day: '', operations: 0, voice: 0 }, voiceReservations: 0 };
      this.record(s, team, actor, 'create');
      return { team };
    }, true);
  }
  async allowed(team: string, actor: string): Promise<boolean> {
    try { return await this.transact(team, s => { this.member(s, actor); return true; }); } catch { return false; }
  }
  async request(team: string, authorization: string | undefined, body: Record<string, unknown>) {
    const identity = await this.hosted.identity(authorization), actor = teamHash(identity.uid);
    const action = body.action;
    if (!['read', 'replace', 'erase', 'invite', 'join', 'revoke', 'close', 'audit', 'voice'].includes(String(action))) throw new TeamError(400, 'TEAM_ACTION', 'この操作には対応していません。');
    let tasks: ConversationTask[] | undefined;
    if (action === 'replace') {
      try { tasks = validateTasks(body.tasks); } catch { throw new TeamError(400, 'TEAM_TASKS', 'タスクの形式が正しくありません。保存内容は変更していません。'); }
    }
    const invitationToken = action === 'invite' ? randomBytes(32).toString('base64url') : undefined;
    const result = await this.transact(team, s => {
      if (action === 'join') this.join(s, identity, body.token);
      const p = this.member(s, actor, ['invite', 'revoke', 'erase', 'close', 'audit'].includes(String(action)));
      this.record(s, team, actor, String(action), tasks?.length ?? 0);
      if (action === 'voice') {
        if (body.consent !== TEAM_CONSENT) throw new TeamError(400, 'TEAM_CONSENT', '音声とタスクをAIに共有する説明を確認してください。');
        if (p.usage.voice >= 3 || p.voiceReservations >= 20) throw new TeamError(429, 'TEAM_VOICE_LIMIT', 'チームの音声利用上限に達しました。入力による整理は続けられます。');
        p.usage.voice++; p.voiceReservations++;
      }
      if (action === 'invite') {
        const email = body.email;
        if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new TeamError(400, 'TEAM_EMAIL', '招待する方のメールアドレスを入力してください。');
        p.invites = p.invites.filter(i => i.expiresAt > this.now());
        const emailHash = teamHash(email.trim().toLowerCase());
        p.invites = p.invites.filter(i => i.emailHash !== emailHash);
        if (p.invites.length + Object.keys(p.members).length >= 5) throw new TeamError(429, 'TEAM_MEMBERS', 'チームは招待中を含め5名までです。');
        const name = body.name ?? 'メンバー';
        if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new TeamError(400, 'TEAM_NAME', '表示名は40文字以内で入力してください。');
        p.invites.push({ name: name.trim(), hash: teamHash(invitationToken!), emailHash, expiresAt: this.now() + 2 * DAY });
      }
      if (action === 'revoke') {
        if (body.member === p.owner || typeof body.member !== 'string' || !p.members[body.member]) throw new TeamError(400, 'TEAM_MEMBER', '削除できるメンバーを選んでください。');
        delete p.members[body.member]; delete p.names[body.member];
      }
      const current = s.workspace && s.workspace.expiresAt > this.now() ? s.workspace : null;
      if (current) validateTasks(current.tasks);
      if (['replace', 'erase', 'close'].includes(String(action))) {
        if (body.revision !== p.revision) throw new TeamError(409, 'TEAM_CONFLICT', '別の画面で更新されています。最新の内容を読み直してください。');
        p.revision = randomUUID();
        if (action === 'replace') {
          const at = new Date(this.now()).toISOString();
          tasks = tasks!.map(t => {
            const previous = current?.tasks.find(old => old.id === t.id);
            return t.due ? { ...t, dueRecordedAt: previous?.due === t.due ? previous.dueRecordedAt ?? at : at } : t;
          });
          s.workspace = { revision: p.revision, tasks: tasks!, updatedAt: this.now(), expiresAt: p.expiresAt };
        } else s.workspace = null;
        if (action === 'close') { p.active = false; p.members = {}; p.names = {}; p.invites = []; p.name = 'Closed team'; }
      }
      const data = s.workspace && s.workspace.expiresAt > this.now() ? s.workspace : null;
      return { team, name: p.name, role: p.members[actor] ?? 'closed', members: p.members[actor] === 'admin' ? Object.entries(p.members).map(([id, role]) => ({ id, role, name: p.names[id] ?? 'メンバー' })) : [], revision: p.revision, tasks: data?.tasks ?? [], expiresAt: p.expiresAt, voiceReservations: p.voiceReservations, consentVersion: TEAM_CONSENT, ...(invitationToken ? { invitationToken } : {}) };
    });
    if (action === 'voice') {
      // Team/global reservations both remain consumed on downstream failure; never refund on a retry.
      return this.hosted.reserve(authorization, { id: team, actor });
    }
    if (action === 'audit') {
      try { return { ...result, audit: (await this.store!.audit(team)).filter(e => e.expiresAt > this.now()) }; }
      catch { throw new TeamError(503, 'TEAM_AUDIT_UNAVAILABLE', '監査記録を読み込めませんでした。'); }
    }
    return result;
  }
  private join(s: TeamState, identity: HostedIdentity, token: unknown) {
    const p = s.policy;
    if (!p || !p.active || p.expiresAt <= this.now() || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token) || !identity.email) throw denied();
    const invite = p.invites.find(i => i.hash === teamHash(token) && i.emailHash === teamHash(identity.email!.toLowerCase()) && i.expiresAt > this.now());
    if (!invite) throw denied();
    const actor = teamHash(identity.uid);
    if (!p.members[actor] && Object.keys(p.members).length >= 5) throw new TeamError(429, 'TEAM_MEMBERS', 'チームは5名までです。');
    p.members[actor] ??= 'member';
    p.names[actor] ??= invite.name;
    p.invites = p.invites.filter(i => i !== invite);
  }
}

export function createTeamRoutes(env: BrokerEnv, service: TeamWorkspaceService) {
  const app = new Hono();
  app.onError((error, c) => {
    c.header('Cache-Control', 'no-store');
    if (error instanceof TeamError || error instanceof HostedAccessError) return c.json({ error: error.code, message: error.message }, error.status);
    return c.json({ error: 'TEAM_UNAVAILABLE', message: 'チームを読み込めませんでした。' }, 503);
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const origin = c.req.header('origin');
    const allowed = [env.RECALL_BOT_PAGE_URL, 'http://127.0.0.1:5180', 'http://localhost:5180', 'http://localhost:5173', 'http://127.0.0.1:5173'];
    if (origin && !allowed.includes(origin)) return c.json({ error: 'TEAM_ORIGIN', message: 'この画面からは操作できません。' }, 403);
    await next();
  });
  const body = async (req: Request): Promise<Record<string, unknown>> => {
    if (!req.headers.get('content-type')?.startsWith('application/json')) throw new TeamError(400, 'TEAM_BODY', 'JSON形式で送信してください。');
    const reader = req.body?.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
    if (!reader) throw new TeamError(400, 'TEAM_BODY', '入力内容がありません。');
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 100_000) { await reader.cancel(); throw new TeamError(413, 'TEAM_BODY_LIMIT', '入力内容が大きすぎます。'); } chunks.push(chunk.value); } }
    finally { reader.releaseLock(); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new TeamError(400, 'TEAM_BODY', '入力内容の形式を確認してください。'); }
  };
  app.post('/create', async c => c.json(await service.create(c.req.header('authorization'), (await body(c.req.raw)).name)));
  app.post('/:team', async c => c.json(await service.request(c.req.param('team'), c.req.header('authorization'), await body(c.req.raw))));
  return app;
}
