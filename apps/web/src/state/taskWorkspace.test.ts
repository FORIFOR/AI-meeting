import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PersistentTaskLedger, TaskWorkspace, parseTaskBackup } from './taskWorkspace.js';

const workspace = () => new TaskWorkspace(`test-${crypto.randomUUID()}`);
describe('durable task workspace', () => {
  it('restores across instances and records the date of a relative deadline', async () => {
    const name = `test-${crypto.randomUUID()}`, a = new TaskWorkspace(name);
    await a.add('見積書を送る', '明日');
    const before = (await a.read())[0]!;
    expect(before.dueRecordedAt).toMatch(/^20/);
    const b = new TaskWorkspace(name);
    expect(await b.read()).toEqual([before]);
    await b.update(before, { status: 'done' });
    expect((await a.read())[0]).toEqual({ ...before, status: 'done' });
    await expect(a.update(before, { status: 'deferred' })).rejects.toThrow('別の画面');
    expect((await a.read())[0]?.status).toBe('done');
  });

  it('serializes concurrent tabs without dropping additions', async () => {
    const name = `test-${crypto.randomUUID()}`;
    await Promise.all(Array.from({ length: 20 }, (_, i) => new TaskWorkspace(name).add(`タスク${i}`, '')));
    const tasks = await new TaskWorkspace(name).read();
    expect(tasks).toHaveLength(20); expect(new Set(tasks.map(t => t.id)).size).toBe(20);
  });

  it('keeps existing data on invalid writes and incompatible imports', async () => {
    const s = workspace(); await s.add('請求書', '9/15'); const before = await s.read();
    await expect(s.add('x'.repeat(161), '')).rejects.toThrow();
    await expect(s.import({ version: 1, tasks: [{ ...before[0]!, status: 'done' }] })).rejects.toThrow('異なる変更');
    await expect(s.import({ version: 2, tasks: [] } as any)).rejects.toThrow();
    expect(await s.read()).toEqual(before);
  });

  it('round-trips a backup without changing dates and keeps imports idempotent', async () => {
    const s = workspace(); await s.add('資料を読む', '今日'); const before = await s.read();
    const destination = workspace();
    const backup = parseTaskBackup(JSON.parse(JSON.stringify({ version: 1, tasks: before })));
    await destination.import(backup); await destination.import(backup);
    expect(await destination.read()).toEqual(before);
  });

  it('does not replace a corrupt or future schema with an empty workspace', async () => {
    const name = `test-${crypto.randomUUID()}`, s = new TaskWorkspace(name); await s.add('保護する', '');
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => { const t = db.transaction('workspace', 'readwrite'); t.objectStore('workspace').put({ version: 99, tasks: ['unsupported'] }, 'current'); t.oncomplete = () => resolve(); });
    await expect(s.read()).rejects.toThrow('対応していません');
    await expect(s.add('上書きしない', '')).rejects.toThrow();
    const raw = await new Promise(resolve => { const r = db.transaction('workspace').objectStore('workspace').get('current'); r.onsuccess = () => resolve(r.result); });
    expect(raw).toEqual({ version: 99, tasks: ['unsupported'] }); db.close();
  });

  it('shares live tasks across sessions but never persists an unconfirmed proposal', async () => {
    const s = workspace(), a = new PersistentTaskLedger(s);
    await a.apply({ operations: [{ action: 'add', title: '資料を作る', quote: '資料を作る' }] }, '資料を作る');
    const b = new PersistentTaskLedger(s);
    expect(await b.read()).toHaveLength(1);
    const args = { operations: [{ action: 'update', id: 'task-1', status: 'done', quote: '終わった' }] };
    expect((await b.apply(args, '聞き取れない')).error).toBeDefined();
    const proposal = (await b.propose(args)).proposal!;
    expect((await s.read())[0]?.status).toBe('pending');
    await b.resolve(proposal.id, true);
    expect((await a.read())[0]?.status).toBe('done');
    expect(new PersistentTaskLedger(s).pending()).toEqual([]);
  });

  it('rejects a stale proposal when another tab updated or deleted its task', async () => {
    const s = workspace(), live = new PersistentTaskLedger(s);
    await s.add('資料', ''); const task = (await s.read())[0]!;
    const p = (await live.propose({ operations: [{ action: 'update', id: task.id, status: 'done', quote: '終わった' }] })).proposal!;
    await s.update(task, { status: 'deferred' });
    expect((await live.resolve(p.id, true)).error).toContain('task changed');
    expect((await s.read())[0]?.status).toBe('deferred');
  });

  it('restores deleted ID gaps without generating duplicate IDs', async () => {
    const s = workspace(), live = new PersistentTaskLedger(s);
    await s.import({ version: 1, tasks: [{ id: 'task-2', title: '既存', status: 'pending' }] });
    await live.apply({ operations: [{ action: 'add', title: '新規', quote: '新規' }] }, '新規');
    expect((await s.read()).map(t => t.id)).toEqual(['task-2', 'task-3']);
  });
});
