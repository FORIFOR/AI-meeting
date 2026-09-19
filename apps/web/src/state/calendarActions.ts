import type { ExecutionState } from '@rcai/conversation-core';

export interface CalendarPayload { title: string; start: string; end: string; timeZone: string; projectId: string; taskId: string }
export interface CalendarAccount { subject: string; email: string }
export interface CalendarAction {
  id: string; payload: CalendarPayload; account: CalendarAccount; state: ExecutionState | 'cancelled';
  revision: number; createdAt: number; updatedAt: number; approvedAt?: number; verifiedAt?: number;
  error?: string; externalId?: string;
}
export function validateCalendarPayload(x: CalendarPayload): CalendarPayload {
  if (!x || typeof x.title !== 'string' || !x.title.trim() || x.title.length > 160 ||
      typeof x.projectId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.projectId) ||
      typeof x.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(x.taskId)) throw new Error('予定の入力が不正です。');
  for (const time of [x.start, x.end]) if (typeof time !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/.test(time) || !Number.isFinite(Date.parse(time))) throw new Error('開始・終了日時をタイムゾーン付きで指定してください。');
  if (Date.parse(x.start) >= Date.parse(x.end)) throw new Error('終了は開始より後にしてください。');
  if (typeof x.timeZone !== 'string') throw new Error('タイムゾーンを確認してください。');
  try { new Intl.DateTimeFormat('ja', { timeZone: x.timeZone }).format(); } catch { throw new Error('タイムゾーンを確認してください。'); }
  return { title: x.title.trim(), start: new Date(x.start).toISOString(), end: new Date(x.end).toISOString(), timeZone: x.timeZone, projectId: x.projectId, taskId: x.taskId };
}
export function validateCalendarAction(raw: unknown): CalendarAction {
  const x = raw as CalendarAction;
  if (!x || typeof x.id !== 'string' || !/^[0-9a-f]{32}$/.test(x.id) || !['draft','approved','executing','verified','failed','unknown','cancelled'].includes(x.state) ||
      !Number.isSafeInteger(x.revision) || x.revision < 1 || !Number.isFinite(x.createdAt) || !Number.isFinite(x.updatedAt) ||
      typeof x.account?.subject !== 'string' || !x.account.subject || typeof x.account.email !== 'string' || !x.account.email) throw new Error('実行履歴の形式が不正です。');
  for (const at of [x.approvedAt, x.verifiedAt]) if (at !== undefined && !Number.isFinite(at)) throw new Error('実行履歴の日時が不正です。');
  if (x.state === 'verified' && (x.externalId !== x.id || x.approvedAt === undefined || x.verifiedAt === undefined)) throw new Error('検証済みの実行記録が不足しています。');
  return { id:x.id, state:x.state, revision:x.revision, createdAt:x.createdAt, updatedAt:x.updatedAt,
    payload: validateCalendarPayload(x.payload), account: { subject: x.account.subject, email: x.account.email },
    ...(x.approvedAt !== undefined ? {approvedAt:x.approvedAt}:{}), ...(x.verifiedAt !== undefined ? {verifiedAt:x.verifiedAt}:{}),
    ...(typeof x.error === 'string' ? {error:x.error.slice(0,500)}:{}), ...(typeof x.externalId === 'string' ? {externalId:x.externalId}:{}),
  };
}
/** Atomic revision checks serialize tabs. No credentials are persisted. */
export class CalendarActionStore {
  constructor(private readonly name = 'ai-meeting-calendar-actions-v1') {}
  private async open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('actions', { keyPath: 'id' });
      r.onerror = () => reject(new Error('実行履歴を保存できません。操作は開始していません。'));
      r.onblocked = () => reject(new Error('別のタブを閉じてください。'));
      r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
    });
  }
  private async transaction<T>(write: boolean, change: (rows: CalendarAction[]) => { value: T; put?: CalendarAction }): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('actions', write ? 'readwrite' : 'readonly');
      const store = tx.objectStore('actions'); let value: T; let failure: unknown;
      const r = store.getAll(); r.onsuccess = () => {
        try { const result = change(r.result.map(validateCalendarAction)); value = result.value; if (result.put) store.put(validateCalendarAction(result.put)); }
        catch (e) { failure = e; tx.abort(); }
      };
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(failure ?? new Error('実行履歴を保存できませんでした。結果の再確認が必要です。')); };
      tx.onerror = () => { failure ??= tx.error; };
    });
  }
  list(projectId?: string): Promise<CalendarAction[]> {
    return this.transaction(false, rows => ({ value: rows.filter(x => !projectId || x.payload.projectId === projectId).sort((a,b) => b.updatedAt-a.updatedAt) }));
  }
  async draft(payload: CalendarPayload, account: CalendarAccount): Promise<CalendarAction> {
    const p = validateCalendarPayload(payload), now = Date.now();
    const next: CalendarAction = { id: crypto.randomUUID().replace(/-/g,''), payload: p, account, state:'draft', revision:1, createdAt:now, updatedAt:now };
    validateCalendarAction(next);
    return this.transaction(true, rows => {
      const existing = rows.find(x => x.payload.projectId === p.projectId && x.payload.taskId === p.taskId && x.state !== 'cancelled');
      if (existing) throw new Error('このタスクには既に登録案または実行履歴があります。履歴から確認してください。');
      return { value: next, put: next };
    });
  }
  change(before: CalendarAction, update: Partial<Pick<CalendarAction,'state'|'approvedAt'|'verifiedAt'|'error'|'externalId'>>): Promise<CalendarAction> {
    return this.transaction(true, rows => {
      const current = rows.find(x => x.id === before.id);
      if (!current || current.revision !== before.revision) throw new Error('別の画面で更新されています。履歴を再読み込みしてください。');
      const next = { ...current, ...update, revision:current.revision+1, updatedAt:Date.now() };
      return { value:next, put:next };
    });
  }
}
export interface CalendarAdapter { account: CalendarAccount; insert(action: CalendarAction): Promise<void>; matches(action: CalendarAction): Promise<'verified'|'missing'|'mismatch'> }
export class CalendarExecutor {
  constructor(private readonly store = new CalendarActionStore(), private readonly cloudAllowed: () => boolean = () => false) {}
  private check(action: CalendarAction, adapter: CalendarAdapter) {
    if (!this.cloudAllowed()) throw new Error('ローカル限定モードでは外部サービスへ接続しません。');
    if (action.account.subject !== adapter.account.subject) throw new Error('承認するGoogleアカウントが登録案と異なります。');
  }
  /** Called only by the explicit approval button; never registered as an LLM tool. */
  async approve(action: CalendarAction, adapter: CalendarAdapter): Promise<CalendarAction> {
    this.check(action, adapter);
    if (action.state !== 'draft') throw new Error('実行済み・結果不明の操作は再送しません。結果を再確認してください。');
    let current = await this.store.change(action, { state:'approved', approvedAt:Date.now() });
    current = await this.store.change(current, { state:'executing' }); // Durable before the first side effect.
    try {
      this.check(current, adapter);
      await adapter.insert(current);
      return await this.verify(current, adapter);
    } catch {
      // A lost response does not prove failure. The stable event id is retained for read-only recovery.
      return this.store.change(current, { state:'unknown', error:'結果を確認できません。再送せず、同じアカウントで結果を再確認してください。' });
    }
  }
  async reconcile(action: CalendarAction, adapter: CalendarAdapter): Promise<CalendarAction> {
    this.check(action, adapter);
    if (!['approved','executing','unknown'].includes(action.state)) throw new Error('再確認の対象ではありません。');
    // Never insert on reload or reconnect, even if GET returns 404.
    return this.verify(action, adapter);
  }
  private async verify(action: CalendarAction, adapter: CalendarAdapter): Promise<CalendarAction> {
    this.check(action, adapter);
    let result: 'verified'|'missing'|'mismatch';
    try { result = await adapter.matches(action); }
    catch { return this.store.change(action, { state:'unknown', error:'登録結果の照会に失敗しました。自動再送は行いません。' }); }
    return result === 'verified'
      ? this.store.change(action, { state:'verified', externalId:action.id, verifiedAt:Date.now(), error:undefined })
      : this.store.change(action, { state:'unknown', error:result === 'missing' ? '同じIDの予定が見つかりません。Googleカレンダー側を確認してください。自動再送は行いません。' : '予定の内容が登録案と一致しません。Googleカレンダー側で確認してください。' });
  }
}

/** Reject browser Date normalization (e.g. February 30 or a skipped DST clock hour). */
export function localDateTimeToIso(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!parts) throw new Error('開始と終了の日時を指定してください。');
  const [year,month,day,hour,minute] = parts.slice(1).map(Number);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getFullYear() !== year || date.getMonth()+1 !== month || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute) throw new Error('存在しない日時です。日付・時刻とタイムゾーンを確認してください。');
  return date.toISOString();
}
