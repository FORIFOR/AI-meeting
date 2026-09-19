import { localCue, validateLiveCue, type CueCandidate, type CueProvider, type ConversationTask } from '@rcai/conversation-core';
import type { ProjectNote } from '../state/projectWorkspace.js';

export function cueCandidates(tasks: ConversationTask[], project: ProjectNote | null, text: string): CueCandidate[] {
  const values: CueCandidate[] = tasks.filter(t => t.status !== 'done').map((t, i) => ({ id: `task_${i}`, label: t.title.slice(0, 160), kind: 'task' }));
  for (const [kind, entries] of [['question', project?.openQuestions], ['next_step', project?.nextSteps], ['decision', project?.decisions]] as const) {
    entries?.forEach((label, i) => values.push({ id: `${kind}_${i}`, label: label.slice(0, 160), kind }));
  }
  // Only this small, relevant shortlist can leave the browser. Never send the complete project memo.
  const ranked = values.filter(v => v.label.trim()).map((v, i) => ({ v, i, matched: text.trim() ? localCue({ text: text.slice(-800), candidates: [v] }).candidateId === v.id : false }));
  ranked.sort((a, b) => Number(b.matched) - Number(a.matched) || a.i - b.i);
  return ranked.slice(0, 12).map(x => x.v);
}

export function cueEndpoint(brokerUrl: string): string {
  const url = new URL(brokerUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' && url.pathname !== '') throw new Error('invalid cue broker');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('cue broker requires HTTPS');
  return `${url.origin}/api/live-cues/`;
}

export function remoteCueProvider(options: { brokerUrl: string; token: string; consent: boolean; privacyMode: 'default' | 'strict_local'; team: boolean; fetchImpl?: typeof fetch }): CueProvider {
  return async (input, signal) => {
    if (options.privacyMode === 'strict_local' || options.team || !options.consent || !/^[^\s]{32,512}$/.test(options.token)) throw new Error('Jev is not authorized for this session');
    const endpoint = cueEndpoint(options.brokerUrl);
    if (signal.aborted) throw new Error('cue cancelled');
    const response = await (options.fetchImpl ?? fetch)(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.token}` },
      body: JSON.stringify({ input, consent: 'live-cues-v1', privacyMode: 'default' }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Jev cue unavailable'); }
    const cue = validateLiveCue(await response.json(), input);
    if (cue.source !== 'jev') throw new Error('unexpected cue provider');
    return cue;
  };
}
