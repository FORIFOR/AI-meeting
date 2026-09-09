// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Result } from './Result.js';
import type { SessionOutcome } from '../session/SessionController.js';
function outcome(mode: string): SessionOutcome {
  return {
    record: { mode, language: 'ja-JP', startedAt: 1, endedAt: 1001, turns: [{role:'user',text:'今日は少し疲れました。'}], interruptions:{byUser:0} },
    evaluation: { overall:0,clarity:0,specificity:0,structure:0,relevance:0,fluency:0,feedback:['答えを改善してください。'] },
    deferred:[],providerId:'google',latency:{turn_response:{p50:0,p95:0}},report:null,
  } as unknown as SessionOutcome;
}
const render=(value:SessionOutcome)=>renderToStaticMarkup(createElement(Result,{outcome:value,onHome:()=>{},onAgain:()=>{}}));
describe('result matches the purpose of the session',()=>{
  it('never grades a companion, even when an older outcome contains scores',()=>{
    const html=render(outcome('companion'));
    expect(html).toContain('話してくれてありがとう');
    expect(html).toContain('今日は少し疲れました。');
    expect(html).not.toContain('result__score');
    expect(html).not.toContain('答えを改善');
    expect(html).not.toContain('明瞭さ');
  });
  it('does not report missing evaluation as an error for a companion',()=>{
    const value=outcome('companion');value.evaluation=null;
    expect(render(value)).not.toContain('評価を取得できませんでした');
  });
  it('preserves practice scores for interviews',()=>{
    expect(render(outcome('interview'))).toContain('result__score');
    expect(render(outcome('interview'))).toContain('明瞭さ');
  });
  it('keeps task deadlines and completion on the result without grading the user',()=>{
    const value=outcome('task_planning');
    value.tasks=[{id:'one',title:'見積書を送る',due:'15時まで',status:'pending'},{id:'two',title:'牛乳を買う',status:'done'}];
    const html=render(value);
    expect(html).toContain('15時まで');
    expect(html).toContain('完了');
    expect(html).not.toContain('result__score');
    expect(html).not.toContain('答えを改善');
  });
});
