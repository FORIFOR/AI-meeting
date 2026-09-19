import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUE_INTENTS, LiveCueScheduler, jevCueRequest, localCue, parseJevCue, validateCueInput, type CueInput, type LiveCue } from './liveCues.js';
const input: CueInput = { text: '予算確認を先に進めたい', candidates: [{ id: 'budget', label: '予算確認', kind: 'task' }] };
const answer = (labels: string[], selected: string, confidence = .95) => ({ type: 'choice', choice: selected, confidence, probabilities: Object.fromEntries(labels.map(k => [k, k === selected ? 1 : 0])) });
const response = () => ({ answers: { focus: answer(['none', 'c0'], 'c0'), intent: answer(CUE_INTENTS, 'plan') } });
afterEach(() => vi.useRealTimers());

describe('live cue contract', () => {
  it('selects existing references from partial text without pretending local scores are confidence', () => {
    expect(localCue(input)).toEqual({ candidateId: 'budget', intent: 'plan', source: 'local', confidence: null });
    expect(localCue({ ...input, text: 'こんにちは' }).candidateId).toBeNull();
  });
  it('treats a correction as clarification, not a task mutation or a human diagnosis', () => {
    expect(localCue({ ...input, text: '違う、予算確認ではなく比較したい' }).intent).toBe('clarify');
    expect(Object.keys(localCue(input)).sort()).toEqual(['candidateId', 'confidence', 'intent', 'source']);
  });
  it('bounds the input and rejects duplicate candidates and malformed values', () => {
    for (const value of [null, {}, { ...input, text: 'x'.repeat(801) }, { ...input, candidates: Array(13).fill(input.candidates[0]) }, { ...input, candidates: [input.candidates[0], input.candidates[0]] }]) expect(() => validateCueInput(value)).toThrow();
  });
  it('asks both questions in one request, with no transcript history, raw audio or tools', () => {
    const body = jevCueRequest(input);
    expect(body.model).toBe('jev-latest'); expect(Object.keys(body.questions)).toEqual(['focus', 'intent']);
    expect(body.state).toEqual({ utterance: input.text });
    expect(body.questions.focus.criteria.c0).toContain('予算確認');
    expect(body).not.toHaveProperty('tools');
  });
  it('keeps a valid choice space even when there are no saved references', () => {
    const empty = { ...input, candidates: [] };
    const criteria = jevCueRequest(empty).questions.focus.criteria;
    expect(Object.keys(criteria).length).toBeGreaterThanOrEqual(2);
    const result = parseJevCue({ answers: { focus: answer(Object.keys(criteria), 'none'), intent: answer(CUE_INTENTS, 'explore') } }, empty);
    expect(result.candidateId).toBeNull();
  });
  it('maps opaque provider labels back to client-owned IDs', () => {
    expect(parseJevCue(response(), input)).toEqual({ candidateId: 'budget', intent: 'plan', source: 'jev', confidence: .95 });
  });
  it('does not surface low-confidence suggestions or expressive guesses', () => {
    const x = response(); x.answers.focus.confidence = .4; x.answers.intent.confidence = .4;
    expect(parseJevCue(x, input)).toMatchObject({ candidateId: null, intent: 'none' });
  });
  it('rejects invented labels, malformed probabilities and inconsistent winners', () => {
    const x = response(); x.answers.focus.choice = 'execute_calendar'; expect(() => parseJevCue(x, input)).toThrow();
    x.answers.focus.choice = 'c0'; x.answers.focus.probabilities.c0 = Number.NaN; expect(() => parseJevCue(x, input)).toThrow();
    x.answers.focus.probabilities = { none: .8, c0: .2 }; expect(() => parseJevCue(x, input)).toThrow();
    x.answers.focus.probabilities = { none: .2, c0: .9 }; expect(() => parseJevCue(x, input)).toThrow();
  });
});

describe('parallel cue scheduling', () => {
  it('debounces partial transcripts and deduplicates identical inputs', async () => {
    vi.useFakeTimers(); const onCue = vi.fn(), provider = vi.fn(async () => localCue(input));
    const s = new LiveCueScheduler({ provider, onCue });
    s.submit({ ...input, text: '予算' }); s.submit(input); s.submit(input);
    await vi.advanceTimersByTimeAsync(200); expect(provider).toHaveBeenCalledOnce(); expect(onCue.mock.calls.at(-1)?.[0]?.candidateId).toBe('budget'); s.dispose();
  });
  it('drops late results when the user corrects the utterance', async () => {
    vi.useFakeTimers(); let resolve!: (value: LiveCue) => void;
    const provider = vi.fn(() => new Promise<LiveCue>(r => { resolve = r; })), onCue = vi.fn();
    const s = new LiveCueScheduler({ provider, onCue });
    s.submit(input); await vi.advanceTimersByTimeAsync(200);
    s.submit({ ...input, text: '訂正、今日は別の話です' });
    resolve({ candidateId: 'budget', intent: 'plan', source: 'jev', confidence: .99 });
    await vi.advanceTimersByTimeAsync(10); expect(onCue.mock.calls.at(-1)?.[0]).toBeNull(); s.dispose();
  });
  it('times out independently and falls back to local without generating speech', async () => {
    vi.useFakeTimers(); const onCue = vi.fn(), onFallback = vi.fn();
    const s = new LiveCueScheduler({ provider: () => new Promise(() => {}), onCue, onFallback, timeoutMs: 100 });
    s.submit(input); await vi.advanceTimersByTimeAsync(300); expect(onFallback).toHaveBeenCalledOnce(); expect(onCue.mock.calls.at(-1)?.[0]?.source).toBe('local'); s.dispose();
  });
  it('aborts in-flight work on clear/dispose and never restores the old suggestion', async () => {
    vi.useFakeTimers(); let resolve!: (value: LiveCue) => void, signal!: AbortSignal;
    const onCue = vi.fn(); const s = new LiveCueScheduler({ provider: (_, a) => { signal = a; return new Promise(r => { resolve = r; }); }, onCue });
    s.submit(input); await vi.advanceTimersByTimeAsync(200); s.clear(); expect(signal.aborted).toBe(true);
    resolve(localCue(input)); await vi.advanceTimersByTimeAsync(10); expect(onCue.mock.calls.at(-1)?.[0]).toBeNull(); s.dispose();
  });
  it('stops remote calls at the session budget rather than retrying forever', async () => {
    vi.useFakeTimers(); const provider = vi.fn(async () => localCue(input)), onCue = vi.fn();
    const s = new LiveCueScheduler({ provider, onCue, maxCalls: 1 });
    s.submit(input); await vi.advanceTimersByTimeAsync(200); s.submit({ ...input, text: '予算確認の続きです' });
    await vi.advanceTimersByTimeAsync(1200); expect(provider).toHaveBeenCalledOnce(); expect(onCue.mock.calls.at(-1)?.[0]?.source).toBe('local'); s.dispose();
  });
});
