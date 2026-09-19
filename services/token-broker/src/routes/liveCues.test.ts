import { describe, expect, it, vi } from 'vitest';
import { CUE_INTENTS } from '@rcai/conversation-core';
import { createLiveCueRoutes } from './liveCues.js';
import { createApp } from '../app.js';
const token = 'decision-only-token-abcdefghijklmnopqrstuvwxyz';
const env = { RCAI_LIVE_CUES_ENABLED: '1', TYPESAFE_API_KEY: 'server-only-typesafe-key', RCAI_LIVE_CUES_TOKEN: token };
const input = { text: '予算確認を先に進めたい', candidates: [{ id: 'budget', label: '予算確認', kind: 'task' }] };
const payload = { consent: 'live-cues-v1', privacyMode: 'default', input };
const headers = { Authorization: `Bearer ${token}`, Origin: 'http://localhost:5173', 'Content-Type': 'application/json' };
const choice = (keys: string[], selected: string) => ({ type: 'choice', choice: selected, confidence: .99, probabilities: Object.fromEntries(keys.map(k => [k, k === selected ? 1 : 0])) });
const answer = () => ({ answers: { focus: choice(['none', 'c0'], 'c0'), intent: choice(CUE_INTENTS, 'plan') } });
const ok = () => new Response(JSON.stringify(answer()));
const req = (body = payload, overrides: Record<string, string> = {}) => ({ method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body) });

describe('optional Jev route', () => {
  it('is disabled without opt-in and on public hosted deployments', async () => {
    const network = vi.fn(async () => ok());
    for (const config of [{}, { ...env, RCAI_PUBLIC_DEMO_ONLY: '1' }, { ...env, RCAI_LIVE_CUES_ENABLED: '0' }, { ...env, RCAI_LIVE_CUES_TOKEN: 'short' }]) {
      expect((await createLiveCueRoutes(config, network).request('/', req())).status).toBe(503);
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('checks capability and origin before any paid request', async () => {
    const network = vi.fn(async () => ok()), app = createLiveCueRoutes(env, network);
    expect((await app.request('/', req(payload, { Authorization: '' }))).status).toBe(401);
    expect((await app.request('/', req(payload, { Authorization: `Bearer ${'a'.repeat(token.length)}` }))).status).toBe(401);
    expect((await app.request('/', req(payload, { Origin: 'https://evil.example' }))).status).toBe(403);
    expect(network).not.toHaveBeenCalled();
  });
  it('rejects missing consent and strict_local, and does not accept an overlarge transcript', async () => {
    const network = vi.fn(async () => ok()), app = createLiveCueRoutes(env, network);
    expect((await app.request('/', req({ ...payload, consent: '' }))).status).toBe(403);
    expect((await app.request('/', req({ ...payload, privacyMode: 'strict_local' }))).status).toBe(403);
    expect((await app.request('/', req({ ...payload, input: { ...input, text: 'a'.repeat(801) } }))).status).toBe(400);
    expect((await app.request('/', { method: 'POST', headers, body: 'x'.repeat(17_000) })).status).toBe(400);
    expect(network).not.toHaveBeenCalled();
  });
  it('sends one typed multi-question request and only returns a validated known reference', async () => {
    const network = vi.fn(async () => ok()), app = createLiveCueRoutes(env, network);
    const response = await app.request('/', req());
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ candidateId: 'budget', intent: 'plan', source: 'jev' });
    const [url, options] = network.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone'); expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer server-only-typesafe-key');
    expect(String(options.body)).not.toContain(token);
    expect(JSON.parse(String(options.body)).state).toEqual({ utterance: input.text });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it('does not turn malformed or unsuccessful provider output into a suggestion', async () => {
    for (const response of [new Response('{}'), new Response('secret detail', { status: 500 }), new Response('x'.repeat(66_000))]) {
      const network = vi.fn(async () => response), app = createLiveCueRoutes(env, network);
      const out = await app.request('/', req()); expect(out.status).toBe(502); expect(await out.text()).not.toContain('secret'); expect(network).toHaveBeenCalledOnce();
    }
  });
  it('enforces interval and finite process budget, including failed attempts', async () => {
    let time = 0; const network = vi.fn(async () => new Response('', { status: 429 })), app = createLiveCueRoutes(env, network, () => time);
    expect((await app.request('/', req())).status).toBe(502);
    expect((await app.request('/', req())).status).toBe(429);
    for (let i = 1; i < 300; i++) { time += 1001; expect((await app.request('/', req())).status).toBe(502); }
    time += 1001; expect((await app.request('/', req())).status).toBe(429); expect(network).toHaveBeenCalledTimes(300);
  });
  it('rejects concurrent calls while the upstream is busy', async () => {
    let resolve!: (value: Response) => void; let time = 0;
    const network = vi.fn(() => new Promise<Response>(r => { resolve = r; })), app = createLiveCueRoutes(env, network, () => time);
    const pending = app.request('/', req()); await vi.waitFor(() => expect(network).toHaveBeenCalledOnce());
    time = 2000; expect((await app.request('/', req())).status).toBe(429); resolve(ok()); expect((await pending).status).toBe(200);
  });
  it('is actually mounted by the application without bypassing the public gate', async () => {
    const network = vi.fn(async () => ok());
    const app = createApp({ env, fetch: network, startWorker: false });
    expect((await app.request('/api/live-cues', req())).status).toBe(200);
    const publicApp = createApp({ env: { ...env, RCAI_PUBLIC_DEMO_ONLY: '1' }, fetch: network, startWorker: false });
    expect((await publicApp.request('/api/live-cues', req())).status).not.toBe(200);
    expect(network).toHaveBeenCalledOnce();
  });
});
