/** Offline aggregation only. Never opens a provider or guesses human participation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const metrics = ['playbackSignal', 'subtitleArrival', 'interruptionSilence'];
const identifier = /^[a-zA-Z0-9_.:-]{1,100}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const number = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;
export function statistics(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const p = n => sorted.length ? sorted[Math.ceil(n / 100 * sorted.length) - 1] : null;
  return { n: sorted.length, p50: p(50), p95: p(95), p99: p(99), max: sorted.at(-1) ?? null };
}

export function aggregate(manifest, readReport, now = Date.now()) {
  requireThat(manifest?.schema === 'rcai.conversation-benchmark.v1' && Array.isArray(manifest.sessions), 'Invalid benchmark manifest');
  const ids = new Set(), hashes = new Set(), sessionIds = new Set(), groups = new Map();
  for (const s of manifest.sessions) {
    requireThat(s && identifier.test(s.id) && !ids.has(s.id), 'Missing or duplicate attempt id'); ids.add(s.id);
    requireThat(/^[a-f0-9]{40}$/.test(s.sourceCommit), `${s.id}: exact source commit required`);
    for (const field of ['model', 'provider', 'configurationId', 'deviceClass']) requireThat(identifier.test(s[field]), `${s.id}: invalid ${field}`);
    requireThat(['human', 'synthetic', 'fixture'].includes(s.inputSource), `${s.id}: explicit input source required`);
    requireThat(['task_planning', 'interview', 'sales', 'english_lesson'].includes(s.mode), `${s.id}: invalid mode`);
    requireThat(['ja', 'en'].includes(s.language), `${s.id}: invalid language`);
    requireThat(['success', 'failure', 'unreviewed'].includes(s.outcome), `${s.id}: invalid outcome`);
    requireThat(Number.isFinite(Date.parse(s.measuredAt)) && Date.parse(s.measuredAt) <= now, `${s.id}: invalid measurement date`);
    if (s.outcome !== 'unreviewed') requireThat(identifier.test(s.reviewRef), `${s.id}: review reference required`);
    if (s.inputSource === 'human') requireThat(s.humanParticipationConfirmed === true && s.consentConfirmed === true && identifier.test(s.reviewRef), `${s.id}: human participation and consent must be reviewed explicitly`);
    const key = [s.sourceCommit, s.configurationId, s.provider, s.model, s.mode, s.language, s.inputSource, s.deviceClass].join('/');
    if (!groups.has(key)) groups.set(key, { sourceCommit: s.sourceCommit, configurationId: s.configurationId, provider: s.provider, model: s.model, mode: s.mode, language: s.language, inputSource: s.inputSource, deviceClass: s.deviceClass, attempts: 0, successes: 0, failures: 0, unreviewed: 0, conversations: 0, durationsMs: [], raw: Object.fromEntries(metrics.map(k => [k, []])), dropped: Object.fromEntries(metrics.map(k => [k, 0])) });
    const g = groups.get(key); g.attempts++; g[{ success: 'successes', failure: 'failures', unreviewed: 'unreviewed' }[s.outcome]]++;
    // Connection failures belong in the denominator even when a report could not be produced.
    if (s.report === null) { requireThat(s.outcome === 'failure', `${s.id}: only failed attempts may omit reports`); continue; }
    requireThat(typeof s.report === 'string' && /^[a-f0-9]{64}$/.test(s.sha256), `${s.id}: report and hash required`);
    const bytes = readReport(s.report);
    requireThat(digest(bytes) === s.sha256 && !hashes.has(s.sha256), `${s.id}: report changed or duplicated`); hashes.add(s.sha256);
    const r = JSON.parse(bytes.toString());
    requireThat(r.schema === 'rcai.benchmark-observation.v1' && r.browserTiming?.schema === 'rcai.browser-timing.v1', `${s.id}: unsupported timing report`);
    requireThat(identifier.test(r.sessionId) && !sessionIds.has(r.sessionId), `${s.id}: duplicate session`); sessionIds.add(r.sessionId);
    requireThat(r.provider === s.provider && number(r.durationMs), `${s.id}: provider or duration mismatch`);
    requireThat(Number.isSafeInteger(r.turns?.user) && r.turns.user >= 0, `${s.id}: invalid turn count`);
    if (r.turns.user > 0) g.conversations++;
    g.durationsMs.push(r.durationMs);
    for (const k of metrics) {
      const values = r.browserTiming.samples?.[k], lost = r.browserTiming.dropped?.[k];
      requireThat(Array.isArray(values) && values.length <= 5000 && values.every(x => number(x) && x <= r.durationMs) && Number.isSafeInteger(lost) && lost >= 0, `${s.id}: invalid ${k} observations`);
      g.raw[k].push(...values); g.dropped[k] += lost;
    }
  }
  return {
    schema: 'rcai.conversation-benchmark-summary.v1', generatedAt: new Date(now).toISOString(),
    scope: 'Browser PCM and subtitle-event timing. Self-reported metadata requires operator review; hashes check integrity, not truth. No physical speaker, display-paint, or production-readiness certification.',
    attempts: ids.size,
    reviewedHumanConversations: [...groups.values()].filter(g => g.inputSource === 'human').reduce((n, g) => n + g.conversations, 0),
    groups: [...groups.values()].map(({ raw, durationsMs, ...g }) => ({
      ...g, successRate: g.unreviewed ? null : g.successes / g.attempts,
      failureRate: g.unreviewed ? null : g.failures / g.attempts,
      duration: statistics(durationsMs),
      timing: Object.fromEntries(metrics.map(k => [k, { ...statistics(raw[k]), dropped: g.dropped[k], complete: g.dropped[k] === 0 }])),
      latencyTargetMet: raw.playbackSignal.length >= 100 && g.dropped.playbackSignal === 0 && statistics(raw.playbackSignal).p50 < 1500 && statistics(raw.playbackSignal).p95 < 3000,
      human100TargetMet: g.inputSource === 'human' && g.conversations >= 100 && g.unreviewed === 0,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/verification/conversation-benchmark.mjs manifest.json summary.json');
  const result = aggregate(JSON.parse(readFileSync(input, 'utf8')), file => readFileSync(resolve(dirname(input), file)));
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ attempts: result.attempts, reviewedHumanConversations: result.reviewedHumanConversations, groups: result.groups.length }));
}
