import { expect, it } from 'vitest';
import { TaskTranscript, configureSessionTools } from './sessionTools.js';
import type { SessionConfig } from '@rcai/conversation-core';
it('preserves consecutive transcript segments while replacing partial revisions', () => {
  const t = new TaskTranscript();
  t.start(0);t.update('牛乳',false,10);t.update('牛乳はもう買いました。',false,20);
  t.start(200);t.update('金額を',false,300);t.update('金額を確認する作業も追加してください。',true,400);
  expect(t.text()).toBe('牛乳はもう買いました。\n金額を確認する作業も追加してください。\n');
  t.start(6000);t.update('見積書を延期します',false,6100);
  expect(t.text()).toBe('見積書を延期します');
});
it('does not offer network lookup in strict local or without tool support', () => {
  for (const [privacyMode,supported] of [['strict_local',true],['default',false]] as const) {
    const config={mode:'free_talk',privacyMode,systemPrompt:'test',language:'ja-JP'} as SessionConfig;
    configureSessionTools(config,supported);
    expect(config.tools).toBeUndefined();
  }
});
