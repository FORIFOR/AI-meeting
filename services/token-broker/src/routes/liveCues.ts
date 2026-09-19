import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { validateCueInput, jevCueRequest, parseJevCue } from '@rcai/conversation-core';
import type { BrokerEnv } from '../env.js';

export interface LiveCueEnv {
  RCAI_LIVE_CUES_ENABLED?: string;
  TYPESAFE_API_KEY?: string;
  /** Dedicated decision-only capability; never reuse an administrator or TypeSafe key. */
  RCAI_LIVE_CUES_TOKEN?: string;
  RCAI_LIVE_CUES_ORIGIN?: string;
}
const localOrigins = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5180', 'http://127.0.0.1:5180'];
export async function boundedText(body: ReadableStream<Uint8Array> | null, maximum: number): Promise<string> {
  if (!body) throw new Error('missing body');
  const reader = body.getReader(), decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('body too large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** Single-operator/self-hosted only. Public hosted and team profiles are deliberately not enabled. */
export function createLiveCueRoutes(env: BrokerEnv & LiveCueEnv, fetchImpl: typeof fetch = fetch, now = Date.now): Hono {
  const app = new Hono();
  let count = 0, inFlight = false, lastCall = -Infinity;
  app.post('/', async c => {
    c.header('Cache-Control', 'no-store');
    if (env.RCAI_LIVE_CUES_ENABLED !== '1' || env.RCAI_PUBLIC_DEMO_ONLY === '1' || !env.TYPESAFE_API_KEY || !env.RCAI_LIVE_CUES_TOKEN || env.RCAI_LIVE_CUES_TOKEN.length < 32) return c.json({ error: 'LIVE_CUES_DISABLED' }, 503);
    const supplied = /^Bearer ([^\s]{32,512})$/.exec(c.req.header('Authorization') ?? '')?.[1] ?? '';
    const expected = env.RCAI_LIVE_CUES_TOKEN;
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return c.json({ error: 'CUE_AUTH_REQUIRED' }, 401);
    const origin = c.req.header('Origin') ?? '';
    if (!localOrigins.includes(origin) && (!env.RCAI_LIVE_CUES_ORIGIN || origin !== env.RCAI_LIVE_CUES_ORIGIN)) return c.json({ error: 'CUE_ORIGIN_DENIED' }, 403);
    if (!c.req.header('Content-Type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'INVALID_CUE_INPUT' }, 400);
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(await boundedText(c.req.raw.body, 16_384)); }
    catch { return c.json({ error: 'INVALID_CUE_INPUT' }, 400); }
    if (!raw || typeof raw !== 'object' || raw.consent !== 'live-cues-v1' || raw.privacyMode !== 'default') return c.json({ error: 'CUE_CONSENT_REQUIRED' }, 403);
    let input;
    try { input = validateCueInput(raw.input); }
    catch { return c.json({ error: 'INVALID_CUE_INPUT' }, 400); }
    // Failed calls still consume capacity. This is a per-process guard, not a provider bill cap.
    if (inFlight || count >= 300 || now() - lastCall < 1000) return c.json({ error: 'CUE_BUDGET_REACHED' }, 429);
    count++; lastCall = now(); inFlight = true;
    try {
      const response = await fetchImpl('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TYPESAFE_API_KEY}` },
        body: JSON.stringify(jevCueRequest(input)),
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(1500)]),
      });
      if (!response.ok) { await response.body?.cancel(); return c.json({ error: 'CUE_PROVIDER_UNAVAILABLE' }, 502); }
      const cue = parseJevCue(JSON.parse(await boundedText(response.body, 65_536)), input);
      return c.json(cue);
    } catch { return c.json({ error: 'CUE_PROVIDER_UNAVAILABLE' }, 502); }
    finally { inFlight = false; }
  });
  return app;
}
