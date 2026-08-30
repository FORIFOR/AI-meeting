import type { ConversationEvent, SessionRecord } from "@rcai/conversation-core";
import type { EvaluationInput, EvaluationProvider, EvaluationResult } from "@rcai/provider-core";

export interface DeferredFeedback {
  afterTurn: number;
  at: number;
  feedback: string[];
  evaluatedBy?: string;
}

/** SessionRecord → EvaluationInput (spec §21); no audio is ever included (§26). */
export function recordToEvaluationInput(record: SessionRecord, params?: Record<string, string | number | boolean>, evaluationProfile?: string): EvaluationInput {
  return {
    mode: record.mode,
    language: record.language,
    evaluationProfile,
    transcript: record.turns.map((t) => ({ role: t.role, text: t.text, interrupted: t.interrupted })),
    timing: record.timing,
    interruptions: record.interruptions,
    audioMetrics: { userLevelDb: record.audioMetrics.userLevelDb },
    params,
  };
}

export interface SidecarOptions {
  /** English lesson: feedback batched every N user turns (spec §20: never per sentence). */
  deferredEveryTurns?: number;
  enableDeferred: boolean;
  evaluator: () => Promise<EvaluationProvider>;
  fallback?: () => Promise<EvaluationProvider>;
  getRecord: () => SessionRecord;
  params?: Record<string, string | number | boolean>;
  evaluationProfile?: string;
  onDeferred?: (f: DeferredFeedback) => void;
  onError?: (e: unknown) => void;
}

/**
 * Evaluator sidecar (spec §21): observes the unified event stream, never sits in the
 * conversation path. Deferred feedback is collected silently and shown only on the result screen.
 */
export class EvaluationSidecar {
  readonly deferred: DeferredFeedback[] = [];
  private userTurns = 0;
  private inflight = false;

  constructor(private readonly opts: SidecarOptions) {}

  handleEvent(e: ConversationEvent): void {
    if (e.type !== "user_transcript" || e.final === false || !e.text.trim()) return;
    this.userTurns++;
    const every = this.opts.deferredEveryTurns ?? 4;
    if (this.opts.enableDeferred && this.userTurns % every === 0 && !this.inflight) void this.runDeferred(this.userTurns);
  }

  private async runDeferred(turn: number): Promise<void> {
    this.inflight = true;
    try {
      const result = await this.evaluate(this.opts.getRecord());
      const f: DeferredFeedback = { afterTurn: turn, at: Date.now(), feedback: result.feedback.slice(0, 3), evaluatedBy: result.evaluatedBy };
      this.deferred.push(f);
      this.opts.onDeferred?.(f);
    } catch (err) {
      this.opts.onError?.(err);
    } finally {
      this.inflight = false;
    }
  }

  /** Final evaluation at session end. Falls back to the offline heuristic when the routed evaluator fails. */
  async finalize(record: SessionRecord): Promise<{ result: EvaluationResult; fallbackUsed: boolean; error?: string }> {
    try {
      return { result: await this.evaluate(record), fallbackUsed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.opts.fallback) throw err;
      const fb = await this.opts.fallback();
      const result = await fb.evaluate(recordToEvaluationInput(record, this.opts.params, this.opts.evaluationProfile));
      return { result, fallbackUsed: true, error: message };
    }
  }

  private async evaluate(record: SessionRecord): Promise<EvaluationResult> {
    const evaluator = await this.opts.evaluator();
    return evaluator.evaluate(recordToEvaluationInput(record, this.opts.params, this.opts.evaluationProfile));
  }
}
