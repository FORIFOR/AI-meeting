import { createHash, randomBytes } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { getApps, initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type { BrokerEnv } from './env.js';

export interface HostedGrant { hash: string; user: string; day: string; expiresAt: number; consumed: boolean; seconds: number }
export interface HostedUsage { grants: HostedGrant[] }
export interface HostedStore { change<T>(month: string, update: (data: HostedUsage) => T): Promise<T> }
export interface HostedIdentity { uid: string; email_verified?: boolean; firebase?: { sign_in_provider?: string } }
export class HostedAccessError extends Error { constructor(readonly status: 401 | 403 | 429 | 503, readonly code: string, message: string) { super(message); } }

export function hostedPolicy(env: BrokerEnv) {
  const seconds = Number(env.RCAI_HOSTED_SESSION_SECONDS ?? 180);
  const daily = Number(env.RCAI_HOSTED_USER_DAILY_SESSIONS ?? 1);
  const monthly = Number(env.RCAI_HOSTED_MONTHLY_SESSIONS ?? 0);
  const enabled = env.RCAI_PUBLIC_DEMO_ONLY === '1' && env.RCAI_HOSTED_ACCESS === '1' && env.GEMINI_BACKEND === 'vertex' && !!env.GOOGLE_CLOUD_PROJECT && !!env.RCAI_HOSTED_FIRESTORE_DATABASE
    && Number.isInteger(seconds) && seconds >= 30 && seconds <= 300
    && Number.isInteger(daily) && daily >= 1 && daily <= 3
    && Number.isInteger(monthly) && monthly >= 1 && monthly <= 1000;
  return { enabled, seconds, daily, monthly };
}

export class FirestoreHostedStore implements HostedStore {
  private db: Firestore;
  constructor(project: string, databaseId: string) { this.db = new Firestore({ projectId: project, databaseId }); }
  async change<T>(month: string, update: (data: HostedUsage) => T): Promise<T> {
    return this.db.runTransaction(async tx => {
      const ref = this.db.collection('ai_meeting_hosted_usage').doc(month);
      const snapshot = await tx.get(ref);
      const data = snapshot.exists ? snapshot.data() as HostedUsage : { grants: [] };
      // Corruption or a schema change must never reset a spending counter.
      if (!Array.isArray(data.grants) || data.grants.some(g => typeof g.hash !== 'string' || typeof g.user !== 'string' || typeof g.day !== 'string' || !Number.isFinite(g.expiresAt) || typeof g.consumed !== 'boolean' || !Number.isInteger(g.seconds))) throw new Error('invalid usage ledger');
      const before = JSON.stringify(data);
      const result = update(data);
      if (before !== JSON.stringify(data)) tx.set(ref, data);
      return result;
    });
  }
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export class HostedAccess {
  readonly policy;
  private readonly store?: HostedStore;
  constructor(private readonly env: BrokerEnv, private readonly deps: { store?: HostedStore; verify?: (token: string) => Promise<HostedIdentity>; now?: () => number } = {}) {
    this.policy = hostedPolicy(env);
    this.store = deps.store ?? (this.policy.enabled ? new FirestoreHostedStore(env.GOOGLE_CLOUD_PROJECT!, env.RCAI_HOSTED_FIRESTORE_DATABASE!) : undefined);
  }
  private now() { return (this.deps.now ?? Date.now)(); }
  private async identity(authorization?: string): Promise<HostedIdentity> {
    if (!this.policy.enabled) throw new HostedAccessError(503, 'HOSTED_DISABLED', '音声体験は現在準備中です。タスク管理はそのまま使えます。');
    const token = /^Bearer ([^\s]{20,8192})$/.exec(authorization ?? '')?.[1];
    if (!token) throw new HostedAccessError(401, 'SIGN_IN_REQUIRED', '音声体験を始めるにはログインしてください。');
    let identity: HostedIdentity;
    try {
      if (this.deps.verify) identity = await this.deps.verify(token);
      else {
        const name = 'ai-meeting-hosted';
        const app = getApps().find(a => a.name === name) ?? initializeApp({ credential: applicationDefault(), projectId: this.env.GOOGLE_CLOUD_PROJECT }, name);
        identity = await getAuth(app).verifyIdToken(token, true);
      }
    } catch { throw new HostedAccessError(401, 'SIGN_IN_REQUIRED', 'ログインの有効期限が切れました。もう一度ログインしてください。'); }
    if (!identity.uid || identity.email_verified !== true || identity.firebase?.sign_in_provider === 'anonymous') throw new HostedAccessError(403, 'EMAIL_VERIFICATION_REQUIRED', '確認メールのリンクを開いてから、メールの確認状況を更新してください。');
    return identity;
  }

  async reserve(authorization?: string) {
    const identity = await this.identity(authorization);
    const now = this.now(), day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
    const token = `hosted_${month}_${randomBytes(32).toString('hex')}`;
    const grant: HostedGrant = { hash: digest(token), user: digest(identity.uid), day, expiresAt: now + 120_000, consumed: false, seconds: this.policy.seconds };
    try {
      await this.store!.change(month, data => {
        if (data.grants.length >= this.policy.monthly) throw new HostedAccessError(429, 'HOSTED_CAPACITY_REACHED', '今月の音声体験の提供枠に達しました。タスク管理は引き続き使えます。');
        if (data.grants.filter(g => g.user === grant.user && g.day === day).length >= this.policy.daily) throw new HostedAccessError(429, 'DAILY_LIMIT_REACHED', '本日の音声体験の上限に達しました。タスクは保存されており、入力で整理を続けられます。');
        data.grants.push(grant);
      });
    } catch (e) { if (e instanceof HostedAccessError) throw e; throw new HostedAccessError(503, 'USAGE_STORE_UNAVAILABLE', '利用枠を確認できませんでした。少し時間をおいてお試しください。'); }
    // Failed connections still consume a reservation. There is no automatic refund or quota reset.
    return { token, expiresAt: grant.expiresAt, sessionSeconds: grant.seconds, backend: 'vertex' as const, model: this.env.VERTEX_LIVE_MODEL ?? 'gemini-live-2.5-flash-native-audio', websocketPath: '/api/live/vertex' };
  }

  async consume(token: string): Promise<{ model: string; seconds: number } | null> {
    if (!this.policy.enabled || !/^hosted_\d{4}-\d{2}_[a-f0-9]{64}$/.test(token)) return null;
    const thisMonth = new Date(this.now()).toISOString().slice(0, 7);
    const previousMonth = new Date(this.now() - 120_000).toISOString().slice(0, 7);
    if (![thisMonth, previousMonth].includes(token.slice(7, 14))) return null;
    try {
      return await this.store!.change(token.slice(7, 14), data => {
        const grant = data.grants.find(g => g.hash === digest(token));
        if (!grant || grant.consumed || grant.expiresAt <= this.now()) return null;
        grant.consumed = true;
        return { model: this.env.VERTEX_LIVE_MODEL ?? 'gemini-live-2.5-flash-native-audio', seconds: Math.min(grant.seconds, this.policy.seconds) };
      });
    } catch { return null; }
  }
}
