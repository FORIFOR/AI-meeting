import { describe, expect, it, vi } from 'vitest';
import { cueCandidates, cueEndpoint, remoteCueProvider } from './liveCueClient.js';
import type { ProjectNote } from '../state/projectWorkspace.js';
const input = { text: '予算確認を先に', candidates: [{ id: 'budget', label: '予算確認', kind: 'task' as const }] };
const token = 'decision-only-capability-abcdefghijklmnopqrstuvwxyz';

describe('cue client', () => {
  it('uses only existing, incomplete tasks and a bounded project shortlist', () => {
    const project: ProjectNote = { id:'p', title:'案件', goal:'Not sent as raw context', decisions:Array.from({length:20},(_,i)=>`決定${i}`), nextSteps:['予算確認'], openQuestions:[], revision:1, updatedAt:1 };
    const result = cueCandidates([{id:'1', title:'終了済み', status:'done'}, {id:'2', title:'請求書', status:'pending'}], project, '予算確認');
    expect(result).toHaveLength(12); expect(result[0]?.label).toBe('予算確認');
    expect(result.some(c => c.label === '終了済み')).toBe(false);
    expect(JSON.stringify(result)).not.toContain(project.goal);
  });
  it('rejects credential-bearing, non-HTTPS and non-root broker URLs', () => {
    expect(cueEndpoint('https://broker.example')).toBe('https://broker.example/api/live-cues/');
    expect(cueEndpoint('http://localhost:8787')).toBe('http://localhost:8787/api/live-cues/');
    for (const url of ['http://remote.example','https://user:pass@broker.example','https://broker.example/?secret=1','https://broker.example/#fragment','https://broker.example/admin']) expect(() => cueEndpoint(url)).toThrow();
  });
  it('does not send a single request without consent or in strict/team mode', async () => {
    const network = vi.fn();
    for (const overrides of [{consent:false}, {privacyMode:'strict_local' as const}, {team:true}, {token:'short'}]) {
      const provider = remoteCueProvider({brokerUrl:'https://broker.example',token,consent:true,privacyMode:'default',team:false,fetchImpl:network,...overrides});
      await expect(provider(input,new AbortController().signal)).rejects.toThrow();
    }
    expect(network).not.toHaveBeenCalled();
  });
  it('sends only the latest input with scoped consent and no persistent credentials', async () => {
    const network = vi.fn(async () => new Response(JSON.stringify({candidateId:'budget',intent:'plan',source:'jev',confidence:.9})));
    const provider = remoteCueProvider({brokerUrl:'https://broker.example',token,consent:true,privacyMode:'default',team:false,fetchImpl:network});
    expect((await provider(input,new AbortController().signal)).candidateId).toBe('budget');
    const [url, options] = network.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://broker.example/api/live-cues/'); expect(options.redirect).toBe('error');
    expect(JSON.parse(String(options.body))).toEqual({input,consent:'live-cues-v1',privacyMode:'default'});
  });
  it('ignores an invented reference or a response mislabelled as local', async () => {
    for (const result of [{candidateId:'send_mail',intent:'plan',source:'jev',confidence:.9},{candidateId:'budget',intent:'plan',source:'local',confidence:null}]) {
      const network = vi.fn(async () => new Response(JSON.stringify(result)));
      const provider = remoteCueProvider({brokerUrl:'https://broker.example',token,consent:true,privacyMode:'default',team:false,fetchImpl:network});
      await expect(provider(input,new AbortController().signal)).rejects.toThrow();
    }
  });
});
