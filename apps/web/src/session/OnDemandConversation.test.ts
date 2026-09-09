import { it, expect, vi, afterEach } from "vitest";
import { OnDemandConversation } from "./OnDemandConversation.js";
import { MeetingMemory } from "./MeetingMemory.js";
import type { ConversationEvent, SessionConfig } from "@rcai/conversation-core";
import type { RealtimeAIProvider } from "@rcai/provider-core";
afterEach(() => vi.useRealTimers());
it("does not connect while observing, wakes once, and closes after the answer plus idle time", async () => {
  vi.useFakeTimers();
  let emit!: (e: ConversationEvent) => void;
  const inner = { id: "google", onEvent: (cb: typeof emit) => { emit = cb; }, connect: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), sendText: vi.fn(async () => {}), pushAudio: vi.fn() };
  const p = new OnDemandConversation(inner as unknown as RealtimeAIProvider);
  await p.connect({ privacyMode: "default" } as SessionConfig);
  p.pushAudio({} as never);
  await vi.advanceTimersByTimeAsync(60000);
  expect(inner.connect).not.toHaveBeenCalled(); expect(inner.pushAudio).not.toHaveBeenCalled();
  await Promise.all([p.sendText("question"), p.sendText("follow-up")]);
  expect(inner.connect).toHaveBeenCalledTimes(1);
  expect(inner.connect.mock.calls[0]).toEqual([expect.objectContaining({ providerOptions: { externalTranscription: true } })]);
  emit({ type: "assistant_speech_ended", at: Date.now() } as ConversationEvent);
  const n = inner.disconnect.mock.calls.length;
  await vi.advanceTimersByTimeAsync(29999); expect(inner.disconnect).toHaveBeenCalledTimes(n);
  await vi.advanceTimersByTimeAsync(1); expect(inner.disconnect).toHaveBeenCalledTimes(n + 1);
  await p.sendText("new topic"); expect(inner.connect).toHaveBeenCalledTimes(2);
  await p.disconnect();
  await expect(p.sendText("after exit")).rejects.toThrow();
});
it("keeps explicit task and decision evidence past recent conversation without inventing owners", () => {
  const memory = new MeetingMemory(); memory.observe("佐藤", "担当は田中さん。金曜日までに資料を作成します。決定です。");
  for (let i = 0; i < 30; i++) memory.observe("山田", `雑談${i}`);
  expect(memory.context()).toContain("金曜日"); expect(memory.context()).toContain("田中");
  expect(memory.context()).toContain("雑談29"); expect(memory.context()).not.toContain("雑談0");
});
it("retrieves an old task after more than four other tasks without growing the prompt with all history", () => {
  const memory = new MeetingMemory(); memory.observe("佐藤", "予算書の担当は田中さん。金曜日までに準備します。");
  for (let i = 0; i < 30; i++) memory.observe("山田", `タスク${i}は月曜日までに確認します。`);
  const context = memory.context("予算書の担当と期限は？");
  expect(context).toContain("予算書の担当は田中さん"); expect(context).toContain("金曜日");
  expect(context).toContain("全件ではありません"); expect(context.length).toBeLessThan(1500);
});
it("cancels a pending wake-up on exit without sending its question", async () => {
  let rejectConnect: ((reason: Error) => void) | undefined;
  const inner = { id: "google", onEvent: () => {}, connect: () => new Promise<void>((_, reject) => { rejectConnect = reject; }), disconnect: async () => { rejectConnect?.(new Error("cancelled")); }, sendText: vi.fn() };
  const p = new OnDemandConversation(inner as unknown as RealtimeAIProvider);
  await p.connect({ privacyMode: "default" } as SessionConfig);
  const pending = p.sendText("question").catch(e => e);
  await p.disconnect();
  expect(await pending).toBeInstanceOf(Error);
  expect(inner.sendText).not.toHaveBeenCalled();
});
