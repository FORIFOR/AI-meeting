/** Latency KPI tracking (spec §27). */

export type LatencyMark =
  | "user_speech_started"
  | "user_speech_ended"
  | "assistant_thinking"
  | "assistant_speech_started"
  | "assistant_speech_ended"
  | "interrupt_requested"
  | "audio_stopped"
  | "avatar_listening"
  | "avatar_mouth_closed";

export interface LatencySample {
  name: LatencyMetricName;
  ms: number;
  at: number;
}

export type LatencyMetricName =
  | "turn_response" // user_speech_ended -> assistant_speech_started
  | "interrupt_stop" // interrupt_requested -> audio_stopped
  | "listening_react" // user_speech_started -> avatar_listening
  | "mouth_stop"; // audio_stopped -> avatar_mouth_closed

export const LATENCY_TARGETS: Record<LatencyMetricName, { p50?: number; p95?: number; max?: number }> = {
  turn_response: { p50: 700, p95: 1500 },
  interrupt_stop: { max: 150 },
  listening_react: { max: 100 },
  mouth_stop: { max: 100 },
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Stage names of a provider-side breakdown (see conversation-core TurnMetrics). */
export type BreakdownField = "vadEndMs" | "sttMs" | "llmTtftMs" | "firstPhraseMs" | "ttsTtfaMs" | "firstAudioSentMs" | "totalMs";
export const BREAKDOWN_FIELDS: BreakdownField[] = ["vadEndMs", "sttMs", "llmTtftMs", "firstPhraseMs", "ttsTtfaMs", "firstAudioSentMs", "totalMs"];

/** A pair whose delta exceeds this is a dangling mark from another turn (e.g. no state transition happened); it is discarded, not sampled. */
export const LATENCY_SANITY_MAX_MS: Record<LatencyMetricName, number> = {
  turn_response: 20_000,
  interrupt_stop: 5_000,
  listening_react: 2_000,
  mouth_stop: 2_000,
};

export class LatencyTracker {
  private marks = new Map<LatencyMark, number>();
  private samples: LatencySample[] = [];
  /** Pairs discarded by the sanity cap, per metric. */
  readonly discarded: Record<LatencyMetricName, number> = { turn_response: 0, interrupt_stop: 0, listening_react: 0, mouth_stop: 0 };
  private breakdowns: Partial<Record<BreakdownField, number>>[] = [];

  /** Record a provider-reported per-turn breakdown (only numeric known fields are kept). */
  recordBreakdown(turn: Record<string, unknown>): void {
    const row: Partial<Record<BreakdownField, number>> = {};
    for (const f of BREAKDOWN_FIELDS) {
      const v = turn[f];
      if (typeof v === "number" && Number.isFinite(v)) row[f] = v;
    }
    this.breakdowns.push(row);
  }

  breakdownSummary(): Record<BreakdownField, { count: number; p50: number; p95: number }> {
    const out = {} as Record<BreakdownField, { count: number; p50: number; p95: number }>;
    for (const f of BREAKDOWN_FIELDS) {
      const values = this.breakdowns.map((b) => b[f]).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
      out[f] = { count: values.length, p50: percentile(values, 50), p95: percentile(values, 95) };
    }
    return out;
  }

  constructor(private readonly clock: () => number = () => (typeof performance !== "undefined" ? performance.now() : Date.now())) {}

  mark(name: LatencyMark, at: number = this.clock()): void {
    this.marks.set(name, at);
    const pair = PAIRS[name];
    if (pair) {
      const start = this.marks.get(pair.from);
      if (start !== undefined && at >= start) {
        const ms = at - start;
        if (ms <= LATENCY_SANITY_MAX_MS[pair.metric]) this.samples.push({ name: pair.metric, ms, at });
        else this.discarded[pair.metric]++;
        this.marks.delete(pair.from);
      }
    }
  }

  getSamples(name?: LatencyMetricName): LatencySample[] {
    return name ? this.samples.filter((s) => s.name === name) : [...this.samples];
  }

  summary(name: LatencyMetricName): { count: number; p50: number; p95: number; max: number } {
    const values = this.getSamples(name)
      .map((s) => s.ms)
      .sort((a, b) => a - b);
    return {
      count: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? values[values.length - 1]! : NaN,
    };
  }

  report(): Record<LatencyMetricName, ReturnType<LatencyTracker["summary"]> & { target: (typeof LATENCY_TARGETS)[LatencyMetricName] }> {
    const out = {} as ReturnType<LatencyTracker["report"]>;
    for (const key of Object.keys(LATENCY_TARGETS) as LatencyMetricName[]) {
      out[key] = { ...this.summary(key), target: LATENCY_TARGETS[key] };
    }
    return out;
  }

  reset(): void {
    this.marks.clear();
    this.samples = [];
    this.breakdowns = [];
  }
}

const PAIRS: Partial<Record<LatencyMark, { from: LatencyMark; metric: LatencyMetricName }>> = {
  assistant_speech_started: { from: "user_speech_ended", metric: "turn_response" },
  audio_stopped: { from: "interrupt_requested", metric: "interrupt_stop" },
  avatar_listening: { from: "user_speech_started", metric: "listening_react" },
  avatar_mouth_closed: { from: "audio_stopped", metric: "mouth_stop" },
};
