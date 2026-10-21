import { TaskLedger, validateTasks, type ConversationTask, type TaskProposal } from '@rcai/conversation-core';

export interface TaskBackup { version: 1; tasks: ConversationTask[] }
const databaseName = 'ai-meeting-tasks';
const storeName = 'workspace';
const storageError = () => new Error('タスクを保存できませんでした。ブラウザーの保存設定や空き容量を確認してください。');

export function parseTaskBackup(value: unknown): TaskBackup {
  if (!value || typeof value !== 'object' || (value as TaskBackup).version !== 1) {
    throw new Error('このバックアップの形式には対応していません。');
  }
  return { version: 1, tasks: validateTasks((value as TaskBackup).tasks) };
}

/** A read/modify/write transaction serializes edits across tabs. No audio or transcripts are stored. */
export class TaskWorkspace {
  constructor(private readonly name = databaseName) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onerror = () => reject(storageError());
      request.onblocked = () => reject(new Error('ほかのAI Meetingのタブを閉じて、もう一度お試しください。'));
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
  }

  private async transaction<T>(mode: IDBTransactionMode, change: (tasks: ConversationTask[]) => { tasks: ConversationTask[]; result: T }): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let result: T;
      let failure: unknown;
      const request = store.get('current');
      request.onsuccess = () => {
        try {
          const current = request.result === undefined ? [] : parseTaskBackup(request.result).tasks;
          const next = change(current);
          if (mode === 'readwrite') store.put({ version: 1, tasks: validateTasks(next.tasks) }, 'current');
          result = next.result;
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => { db.close(); resolve(result); };
      tx.onabort = () => { db.close(); reject(failure ?? storageError()); };
      tx.onerror = () => { failure ??= storageError(); };
    });
  }

  read(): Promise<ConversationTask[]> { return this.transaction('readonly', tasks => ({ tasks, result: tasks })); }

  change<T>(fn: (tasks: ConversationTask[]) => { tasks: ConversationTask[]; result: T }): Promise<T> {
    return this.transaction('readwrite', current => {
      const next = fn(validateTasks(current));
      const at = new Date().toISOString();
      next.tasks = next.tasks.map(task => {
        const before = current.find(t => t.id === task.id);
        return task.due && ((!before && !task.dueRecordedAt) || (before && before.due !== task.due))
          ? { ...task, dueRecordedAt: at } : task;
      });
      return next;
    });
  }

  add(title: string, due: string): Promise<void> {
    return this.change(tasks => ({ tasks: [...tasks, { id: `task-${crypto.randomUUID()}`, title: title.trim(), status: 'pending', ...(due.trim() ? { due: due.trim() } : {}) }], result: undefined }));
  }

  update(before: ConversationTask, changes: Partial<Pick<ConversationTask, 'title' | 'status' | 'due'>>): Promise<void> {
    return this.change(tasks => {
      const index = tasks.findIndex(t => t.id === before.id);
      if (index < 0 || JSON.stringify(tasks[index]) !== JSON.stringify(before)) throw new Error('別の画面で更新されています。最新の内容を確認して、もう一度操作してください。');
      tasks[index] = { ...before, ...changes };
      if (!tasks[index]!.due) { delete tasks[index]!.due; delete tasks[index]!.dueRecordedAt; }
      return { tasks, result: undefined };
    });
  }

  remove(before: ConversationTask): Promise<void> {
    return this.change(tasks => {
      if (JSON.stringify(tasks.find(t => t.id === before.id)) !== JSON.stringify(before)) throw new Error('別の画面で更新されています。最新の内容を確認してください。');
      return { tasks: tasks.filter(t => t.id !== before.id), result: undefined };
    });
  }

  async import(backup: TaskBackup): Promise<void> {
    const incoming = parseTaskBackup(backup).tasks;
    return this.change(tasks => {
      for (const task of incoming) {
        const existing = tasks.find(t => t.id === task.id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(task)) throw new Error('同じタスクに異なる変更があります。現在のタスクをバックアップしてから内容を確認してください。');
        if (!existing) tasks.push(task);
      }
      return { tasks, result: undefined };
    });
  }
}

/** Keeps unverified proposals in memory; only confirmed changes enter durable storage. */
export class PersistentTaskLedger {
  private ledger = new TaskLedger();
  private work: Promise<void> = Promise.resolve();
  // Keep proposals created while a transaction is pending out of an older staged copy.
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.work.then(action);
    this.work = result.then(() => undefined, () => undefined);
    return result;
  }
  constructor(private readonly workspace = new TaskWorkspace()) {}
  private async readCurrent(): Promise<ConversationTask[]> { const tasks = await this.workspace.read(); this.ledger.rebase(tasks); return tasks; }
  read(): Promise<ConversationTask[]> { return this.exclusive(() => this.readCurrent()); }
  snapshot(): ConversationTask[] { return this.ledger.snapshot(); }
  pending(): TaskProposal[] { return this.ledger.pending(); }
  private async commit(change: (ledger: TaskLedger) => ReturnType<TaskLedger['apply']>) {
    let staged: TaskLedger | undefined;
    const result = await this.workspace.change(tasks => {
      staged = this.ledger.copy();
      staged.rebase(tasks);
      const result = change(staged);
      return { tasks: result.tasks, result };
    });
    // workspace.change resolves only after the storage transaction completes.
    // On quota/abort errors the live ledger and its pending confirmation remain intact.
    this.ledger = staged!;
    await this.readCurrent();
    return { ...result, tasks: this.snapshot() };
  }
  async apply(args: Record<string, unknown>, source: string) {
    return this.exclusive(() => this.commit(ledger => ledger.apply(args, source)));
  }
  async propose(args: Record<string, unknown>) { return this.exclusive(async () => { await this.readCurrent(); return this.ledger.propose(args); }); }
  async resolve(id: string, accept: boolean) {
    return this.exclusive(() => this.commit(ledger => ledger.resolve(id, accept)));
  }
}
