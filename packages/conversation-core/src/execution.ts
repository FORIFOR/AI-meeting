export type ExecutionState = "draft" | "approved" | "executing" | "verified" | "failed" | "unknown";

export interface ExecutionRecord<T = unknown> {
  id: string;
  idempotencyKey: string;
  action: string;
  payload: T;
  state: ExecutionState;
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: string;
}

const transitions: Record<ExecutionState, ExecutionState[]> = {
  draft: ["approved"],
  approved: ["executing"],
  executing: ["verified", "failed", "unknown"],
  unknown: ["verified", "failed", "executing"],
  verified: [],
  failed: [],
};

/**
 * Pure lifecycle for external side effects. Conversation code may describe a draft, but it cannot
 * claim success until an adapter has verified the external result.
 */
export class ExecutionLedger<T = unknown> {
  private records = new Map<string, ExecutionRecord<T>>();

  create(input: { id: string; idempotencyKey: string; action: string; payload: T; now?: number }): ExecutionRecord<T> {
    if (!input.id || !input.idempotencyKey || !input.action) throw new Error("invalid execution draft");
    if ([...this.records.values()].some(x => x.idempotencyKey === input.idempotencyKey)) throw new Error("duplicate idempotency key");
    const now = input.now ?? Date.now();
    const record: ExecutionRecord<T> = { ...input, state: "draft", createdAt: now, updatedAt: now };
    delete (record as { now?: number }).now;
    this.records.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  get(id: string): ExecutionRecord<T> | null {
    const value = this.records.get(id);
    return value ? structuredClone(value) : null;
  }

  transition(id: string, state: ExecutionState, details: { result?: unknown; error?: string; now?: number } = {}): ExecutionRecord<T> {
    const current = this.records.get(id);
    if (!current) throw new Error("unknown execution");
    if (!transitions[current.state].includes(state)) throw new Error(`invalid execution transition: ${current.state} -> ${state}`);
    const next: ExecutionRecord<T> = {
      ...current,
      state,
      updatedAt: details.now ?? Date.now(),
      ...(details.result !== undefined ? { result: structuredClone(details.result) } : {}),
      ...(details.error ? { error: details.error } : {}),
    };
    this.records.set(id, next);
    return structuredClone(next);
  }

  canClaimSuccess(id: string): boolean { return this.records.get(id)?.state === "verified"; }
}
