import type { ConversationEvent, SessionRecord } from "@rcai/conversation-core";
import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";
import { sessionRecordToEvaluationInput } from "./record.js";

export interface EvaluationSidecarOptions {
  /** Live record accessor (e.g. `() => conversationRuntime.getRecord()`). */
  getRecord: () => SessionRecord;
  /** Default evaluator; `evaluateNow(provider)` may override per call. */
  provider?: EvaluationProvider;
  params?: Record<string, string | number | boolean>;
  evaluationProfile?: string;
  onError?: (error: unknown) => void;
}

export interface IntervalHandle {
  stop(): void;
}

/**
 * Evaluator Sidecar (spec §21). Observes unified events, never sits in the conversation
 * path: every evaluation is fire-and-forget and errors go to `onError`/the callback.
 */
export class EvaluationSidecar {
  private completedUserTurns = 0;
  private intervals: { every: number; cb: (r: EvaluationResult, turns: number) => void; lastAt: number; provider?: EvaluationProvider }[] = [];
  private inFlight = 0;
  private lastResult: EvaluationResult | null = null;
  private closed = false;

  constructor(private readonly opts: EvaluationSidecarOptions) {}

  get userTurns(): number {
    return this.completedUserTurns;
  }

  get pending(): number {
    return this.inFlight;
  }

  getLastResult(): EvaluationResult | null {
    return this.lastResult;
  }

  /** Subscribe to a runtime-like emitter (`on(listener) => unsubscribe`). */
  attach(source: { on(listener: (e: ConversationEvent) => void): () => void }): () => void {
    return source.on((e) => this.handleEvent(e));
  }

  handleEvent(event: ConversationEvent): void {
    if (this.closed) return;
    if (event.type === "user_transcript" && event.final !== false && event.text.trim()) {
      this.completedUserTurns++;
      for (const iv of this.intervals) {
        if (this.completedUserTurns - iv.lastAt >= iv.every) {
          iv.lastAt = this.completedUserTurns;
          const turns = this.completedUserTurns;
          void this.evaluateNow(iv.provider)
            .then((r) => iv.cb(r, turns))
            .catch((e) => this.opts.onError?.(e));
        }
      }
    } else if (event.type === "session_closed") {
      this.closed = true;
    }
  }

  /** Spec §20: batched feedback every N (3–5) user turns; default 4. */
  onInterval(turns: number, cb: (result: EvaluationResult, completedUserTurns: number) => void, provider?: EvaluationProvider): IntervalHandle;
  onInterval(cb: (result: EvaluationResult, completedUserTurns: number) => void, provider?: EvaluationProvider): IntervalHandle;
  onInterval(a: number | ((r: EvaluationResult, t: number) => void), b?: ((r: EvaluationResult, t: number) => void) | EvaluationProvider, c?: EvaluationProvider): IntervalHandle {
    const every = typeof a === "number" ? Math.max(1, a) : 4;
    const cb = (typeof a === "number" ? b : a) as (r: EvaluationResult, t: number) => void;
    const provider = typeof a === "number" ? c : (b as EvaluationProvider | undefined);
    const entry = { every, cb, lastAt: this.completedUserTurns, provider };
    this.intervals.push(entry);
    return { stop: () => { this.intervals = this.intervals.filter((x) => x !== entry); } };
  }

  buildInput(): EvaluationInput {
    return sessionRecordToEvaluationInput(this.opts.getRecord(), this.opts.params, this.opts.evaluationProfile);
  }

  /** Evaluate the current record with `provider` (or the default). Rejects on error; never throws synchronously. */
  async evaluateNow(provider: EvaluationProvider | undefined = this.opts.provider): Promise<EvaluationResult> {
    if (!provider) throw new Error("EvaluationSidecar: no EvaluationProvider configured");
    this.inFlight++;
    try {
      const result = await provider.evaluate(this.buildInput());
      this.lastResult = result;
      return result;
    } finally {
      this.inFlight--;
    }
  }

  /** Final evaluation at session end (spec §21). Resolves null on failure after reporting. */
  async evaluateFinal(provider?: EvaluationProvider): Promise<EvaluationResult | null> {
    try {
      return await this.evaluateNow(provider);
    } catch (e) {
      this.opts.onError?.(e);
      return null;
    }
  }

  dispose(): void {
    this.closed = true;
    this.intervals = [];
  }
}
