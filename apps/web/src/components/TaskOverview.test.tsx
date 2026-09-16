// @vitest-environment jsdom
import { act, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TaskOverview } from './TaskOverview.js';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Props = ComponentProps<typeof TaskOverview>;
const tasks = [{status:'pending'}, {status:'pending'}, {status:'deferred'}, {status:'done'}] as const;
async function inspect(overrides: Partial<Props>, check: (host: HTMLDivElement) => void | Promise<void>) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<TaskOverview tasks={tasks} ready={true} busy={false} {...overrides}/>));
    await check(host);
  } finally { await act(async () => root.unmount()); host.remove(); }
}
it('separates pending, deferred and completed saved tasks', async () => {
  await inspect({}, host => {
    for (const [state, count] of [['pending','2'],['deferred','1'],['done','1']]) {
      expect(host.querySelector(`[data-task-state="${state}"] dd`)?.textContent).toBe(`${count}件`);
    }
    expect(host.textContent).toContain('保存済み');
  });
});
it('does not claim zero saved tasks before loading completes', async () => {
  await inspect({ready:false, tasks:[]}, host => {
    expect([...host.querySelectorAll('dd')].map(x => x.textContent)).toEqual(['—','—','—']);
    expect(host.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(host.textContent).not.toContain('0件');
  });
});
it('shows real zero counts only after an empty workspace was loaded', async () => {
  await inspect({tasks:[]}, host => expect([...host.querySelectorAll('dd')].map(x => x.textContent)).toEqual(['0件','0件','0件']));
});
it.each([{ready:false},{busy:true}])('does not invoke the voice callback when blocked: %o', async flags => {
  const talk = vi.fn();
  await inspect({...flags,onTalk:talk}, async host => {
    const button = host.querySelector('button')!;
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(talk).not.toHaveBeenCalled();
  });
});
it('explains an unavailable voice path rather than presenting an inert enabled button', async () => {
  await inspect({}, host => {
    expect(host.querySelector('button')?.disabled).toBe(true);
    expect(host.textContent).toContain('この画面では音声を開始できません');
  });
});
it('starts only through the explicitly provided callback', async () => {
  const talk = vi.fn();
  await inspect({onTalk:talk,voiceHint:'音声の利用条件'}, async host => {
    expect(talk).not.toHaveBeenCalled();
    expect(host.textContent).toContain('音声の利用条件');
    expect(host.textContent).not.toContain('この画面では音声を開始できません');
    await act(async () => host.querySelector('button')!.click());
    expect(talk).toHaveBeenCalledTimes(1);
  });
});
