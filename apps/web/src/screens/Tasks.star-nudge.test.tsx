// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { ConversationTask } from '@rcai/conversation-core';
import type { TaskWorkspace } from '../state/taskWorkspace.js';
import { Tasks } from './Tasks.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows the GitHub Star nudge only after a task is saved', async () => {
  let tasks: ConversationTask[] = [];
  const store = {
    read: vi.fn(async () => tasks),
    add: vi.fn(async (title: string, due: string) => {
      tasks = [{ id: 'task-test', title: title.trim(), status: 'pending', ...(due.trim() ? { due: due.trim() } : {}) }];
    }),
    update: vi.fn(),
    remove: vi.fn(),
    import: vi.fn(),
  } as unknown as TaskWorkspace;
  const host = document.createElement('div');
  const root = createRoot(host);
  document.body.append(host);

  try {
    await act(async () => root.render(<Tasks onBack={vi.fn()} store={store} />));
    expect(host.textContent).not.toContain('役立ちそうなら');

    const input = host.querySelector('input[placeholder="例：見積書を送る"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Star案内を確認');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const form = host.querySelector('form.task-add')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(store.add).toHaveBeenCalledWith('Star案内を確認', '');
    expect(host.textContent).toContain('タスクを保存しました。');
    expect(host.querySelector('a[href="https://github.com/FORIFOR/AI-meeting"]')?.textContent).toContain('GitHubでStarする');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
