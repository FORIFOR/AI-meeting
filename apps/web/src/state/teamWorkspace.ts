import { validateTasks, type ConversationTask } from '@rcai/conversation-core';
import { hostedAuth, hostedBrokerAllowed } from '../api/hostedAuth.js';
import { TaskWorkspace } from './taskWorkspace.js';
export interface TeamSnapshot {
  team: string; name: string; role: 'admin' | 'member' | 'closed';
  members: { id: string; role: string; name: string }[]; revision: string | null;
  tasks: ConversationTask[]; expiresAt: number; voiceReservations: number; consentVersion: string;
  invitationToken?: string; audit?: { actor: string; action: string; at: number; count: number }[];
}
export class TeamClientError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function teamRequest<T>(brokerUrl: string, uid: string, team: string, body: Record<string, unknown>): Promise<T> {
  if (!hostedBrokerAllowed(brokerUrl) || !/^(create|team-[a-f0-9]{24})$/.test(team)) throw new Error('接続先を確認してください。');
  const auth = await hostedAuth(), user = auth.currentUser;
  if (!user?.emailVerified || user.uid !== uid) throw new TeamClientError('ログイン状態が変わりました。チームを開き直してください。', 401);
  const token = await user.getIdToken();
  if (auth.currentUser?.uid !== uid) throw new TeamClientError('ログイン状態が変わりました。', 401);
  const response = await fetch(`${brokerUrl.replace(/\/$/, '')}/api/team/${team}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15000),
  });
  if (auth.currentUser?.uid !== uid) throw new TeamClientError('ログイン状態が変わりました。', 401);
  const data = await response.json();
  if (!response.ok) throw new TeamClientError(data.message ?? 'チームに接続できませんでした。', response.status);
  return data as T;
}
/** A remote workspace never falls back to personal IndexedDB or claims an uncertain write succeeded. */
export class TeamTaskWorkspace extends TaskWorkspace {
  private active = true;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly brokerUrl: string, readonly uid: string, readonly team: string) { super(); }
  close() { this.active = false; }
  async request(body: Record<string, unknown>): Promise<TeamSnapshot> {
    if (!this.active) throw new TeamClientError('チームを開き直してください。', 403);
    const result = await teamRequest<TeamSnapshot>(this.brokerUrl, this.uid, this.team, body);
    if (!this.active) throw new TeamClientError('チームを開き直してください。', 403);
    return { ...result, tasks: validateTasks(result.tasks) };
  }
  override async read() { return (await this.request({ action: 'read' })).tasks; }
  override change<T>(fn: (tasks: ConversationTask[]) => { tasks: ConversationTask[]; result: T }): Promise<T> {
    const job = this.queue.catch(() => {}).then(async () => {
      const before = await this.request({ action: 'read' });
      const next = fn(validateTasks(before.tasks));
      const tasks = validateTasks(next.tasks);
      if (JSON.stringify(tasks) !== JSON.stringify(before.tasks)) await this.request({ action: 'replace', revision: before.revision, tasks });
      return next.result;
    });
    this.queue = job;
    return job;
  }
}
