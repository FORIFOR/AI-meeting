import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
// @ts-expect-error Standalone offline CLI is native ESM JavaScript.
import { aggregate } from '../../../scripts/verification/conversation-benchmark.mjs';

const observation = (id: string, values = [200, 800]) => Buffer.from(JSON.stringify({ schema: 'rcai.benchmark-observation.v1', sessionId: id, provider: 'google', durationMs: 180000, turns: { user: 2 }, browserTiming: { schema: 'rcai.browser-timing.v1', samples: { playbackSignal: values, subtitleArrival: [100], interruptionSilence: [] }, dropped: { playbackSignal: 0, subtitleArrival: 0, interruptionSilence: 0 } } }));
const row = (id: string, bytes: Buffer) => ({ id, sourceCommit: 'a'.repeat(40), provider: 'google', model: 'gemini-live-2.5-flash-native-audio', configurationId: 'hosted-v1', deviceClass: 'chrome-desktop', inputSource: 'synthetic', mode: 'task_planning', language: 'ja', outcome: 'success', reviewRef: 'automation-1', measuredAt: '2026-09-01T00:00:00Z', report: id, sha256: createHash('sha256').update(bytes).digest('hex') });
const manifest = (sessions: unknown[]) => ({ schema: 'rcai.conversation-benchmark.v1', sessions });
describe('benchmark evidence integrity', () => {
  it('keeps zero observations unavailable, with zero human sessions', () => {
    const out = aggregate(manifest([]), () => { throw new Error('unused'); });
    expect(out.reviewedHumanConversations).toBe(0); expect(out.groups).toEqual([]);
  });
  it('pools turn samples instead of averaging session percentiles; keeps failures', () => {
    const a = observation('a', [100, 200]), b = observation('b', [3000]);
    const out = aggregate(manifest([row('a', a), row('b', b), { ...row('c', a), report: null, outcome: 'failure' }]), (file: string) => file === 'a' ? a : b);
    expect(out.groups[0].timing.playbackSignal).toMatchObject({ n: 3, p50: 200, p95: 3000, p99: 3000 });
    expect(out.groups[0].successRate).toBe(2 / 3); expect(out.groups[0].human100TargetMet).toBe(false);
    expect(out.reviewedHumanConversations).toBe(0);
  });
  it('rejects changed evidence, duplicated sessions and unconfirmed human claims', () => {
    const a = observation('a'); const s = row('a', a);
    expect(() => aggregate(manifest([s]), () => observation('other'))).toThrow('changed');
    expect(() => aggregate(manifest([s, { ...s, id: 'b' }]), () => a)).toThrow('duplicated');
    expect(() => aggregate(manifest([{ ...s, inputSource: 'human' }]), () => a)).toThrow('consent');
  });
  it('does not combine different configurations or classify fixtures as human', () => {
    const a = observation('a'), b = observation('b');
    const out = aggregate(manifest([row('a', a), { ...row('b', b), configurationId: 'different', inputSource: 'fixture' }]), (file: string) => file === 'a' ? a : b);
    expect(out.groups).toHaveLength(2); expect(out.reviewedHumanConversations).toBe(0);
  });
});
