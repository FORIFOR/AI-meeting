import { describe, expect, it, vi } from 'vitest';
import { HostedAccess, hostedPolicy, type HostedStore, type HostedUsage } from './hosted-access.js';
import { HostedLiveLimits } from './hosted-live-limits.js';
import { createApp } from './app.js';

class MemoryStore implements HostedStore {
  values = new Map<string, HostedUsage>();
  private queue: Promise<unknown> = Promise.resolve();
  change<T>(key: string, fn: (v: HostedUsage) => T): Promise<T> {
    const run = this.queue.then(() => {
      const data = structuredClone(this.values.get(key) ?? { grants: [] });
      const result = fn(data); this.values.set(key, data); return result;
    });
    this.queue = run.catch(() => {}); return run;
  }
}
const env = { RCAI_PUBLIC_DEMO_ONLY: '1', RCAI_HOSTED_ACCESS: '1', RCAI_HOSTED_FIRESTORE_DATABASE: 'test', RCAI_HOSTED_MONTHLY_SESSIONS: '3', RCAI_HOSTED_USER_DAILY_SESSIONS: '1', GEMINI_BACKEND: 'vertex' as const, GOOGLE_CLOUD_PROJECT: 'test' };
const bearer = 'Bearer signed-synthetic-test-token';
const verify = async () => ({ uid: 'u1', email_verified: true, firebase: { sign_in_provider: 'password' } });

describe('authenticated hosted access', () => {
  it.each([{}, { ...env, RCAI_HOSTED_MONTHLY_SESSIONS: '0' }, { ...env, RCAI_HOSTED_SESSION_SECONDS: '99999' }, { ...env, RCAI_HOSTED_FIRESTORE_DATABASE: undefined }, { ...env, GEMINI_BACKEND: 'developer' as const }])('fails closed for missing or invalid configuration', config => {
    expect(hostedPolicy(config).enabled).toBe(false);
  });
  it('requires a verified, non-anonymous identity and rejects invalid signatures', async () => {
    for (const identity of [{ uid: 'u' }, { uid: 'u', email_verified: true, firebase: { sign_in_provider: 'anonymous' } }]) {
      await expect(new HostedAccess(env, { store: new MemoryStore(), verify: async () => identity }).reserve(bearer)).rejects.toMatchObject({ status: 403 });
    }
    const rejected = new HostedAccess(env, { store: new MemoryStore(), verify: async () => { throw new Error('invalid signature'); } });
    await expect(rejected.reserve(bearer)).rejects.toMatchObject({ status: 401 });
    await expect(rejected.reserve()).rejects.toMatchObject({ status: 401 });
  });
  it('atomically limits concurrent requests across separate broker instances', async () => {
    const store = new MemoryStore();
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => new HostedAccess(env, { store, verify }).reserve(bearer)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect([...store.values.values()][0]!.grants).toHaveLength(1);
  });
  it('keeps the global monthly cap across users, restarts and days', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 3; i++) await new HostedAccess(env, { store, verify: async () => ({ ...(await verify()), uid: `u${i}` }), now: () => Date.UTC(2026, 8, 13 + i) }).reserve(bearer);
    await expect(new HostedAccess(env, { store, verify, now: () => Date.UTC(2026, 8, 20) }).reserve(bearer)).rejects.toMatchObject({ code: 'HOSTED_CAPACITY_REACHED' });
    await expect(new HostedAccess(env, { store, verify, now: () => Date.UTC(2026, 9, 1) }).reserve(bearer)).resolves.toMatchObject({ sessionSeconds: 180 });
  });
  it('consumes a ticket once across replicas and rejects expiry, forgery and disabled access', async () => {
    const store = new MemoryStore(); let now = Date.UTC(2026, 8, 13);
    const a = new HostedAccess(env, { store, verify, now: () => now });
    const ticket = await a.reserve(bearer);
    const b = new HostedAccess(env, { store, verify, now: () => now });
    const results = await Promise.all([a.consume(ticket.token), b.consume(ticket.token)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await a.consume(ticket.token + '0')).toBeNull();
    expect(await new HostedAccess({ ...env, RCAI_HOSTED_ACCESS: '0' }, { store }).consume(ticket.token)).toBeNull();
    now += 24 * 3600_000;
    const expired = await b.reserve(bearer); now += 120_001;
    expect(await a.consume(expired.token)).toBeNull();
  });
  it('does not issue tickets when the durable counter is unavailable', async () => {
    const a = new HostedAccess(env, { verify, store: { change: async () => { throw new Error('offline'); } } });
    await expect(a.reserve(bearer)).rejects.toMatchObject({ status: 503, code: 'USAGE_STORE_UNAVAILABLE' });
  });
  it('leaves every direct paid route closed while the hosted route checks authentication', async () => {
    const upstream = vi.fn();
    const app = createApp({ env, hosted: new HostedAccess(env, { store: new MemoryStore(), verify }), fetch: upstream, startWorker: false });
    expect((await app.request('/api/hosted/session', { method: 'POST' })).status).toBe(401);
    const admitted = await app.request('/api/hosted/session', { method: 'POST', headers: { authorization: bearer } });
    expect(admitted.status).toBe(200); expect(admitted.headers.get('Cache-Control')).toBe('no-store');
    expect((await admitted.json() as any).token).toMatch(/^hosted_/);
    for (const route of ['/api/token/gemini', '/api/token/openai', '/api/session/openai-live', '/api/evaluate', '/api/meeting/attendee/bots']) expect((await app.request(route, { method: 'POST', headers: { authorization: bearer } })).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe('hosted relay input bounds', () => {
  it('pins output generation and refuses search, media and history bypasses', () => {
    const limits = new HostedLiveLimits(30);
    const setup = { setup: { generationConfig: { maxOutputTokens: 99999 }, cachedContent: 'attack', sessionResumption: { handle: 'attack' } } };
    limits.check(setup);
    expect(setup.setup.generationConfig.maxOutputTokens).toBe(1024);
    expect(setup.setup).not.toHaveProperty('sessionResumption');
    expect(setup.setup).not.toHaveProperty('cachedContent');
    expect(() => limits.check({ setup: { tools: [{ googleSearch: {} }] } })).toThrow();
    expect(() => limits.check({ clientContent: { turns: [{ parts: [{ fileData: { fileUri: 'gs://external/media' } }] }] } })).toThrow();
    expect(() => limits.check({ realtimeInput: { video: { data: 'large' } } })).toThrow();
  });
  it('bounds audio by decoded duration, not by caller-supplied metadata', () => {
    const limits = new HostedLiveLimits(30), frame = { realtimeInput: { audio: { data: Buffer.alloc(32000).toString('base64'), mimeType: 'audio/pcm;rate=16000' } } };
    for (let i = 0; i < 30; i++) limits.check(frame);
    expect(() => limits.check(frame)).toThrow('audio limit');
    expect(() => new HostedLiveLimits(30).check({ realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=1' } } })).toThrow();
    expect(() => new HostedLiveLimits(30).check({ clientContent: { text: 'x'.repeat(100001) } })).toThrow('text limit');
  });
});
