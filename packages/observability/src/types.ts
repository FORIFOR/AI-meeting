/** Session-level observability (Round 3 Gate 7). No user content is ever part of a report. */

export interface Summary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface HistogramBucket {
  /** Lower bound in ms (inclusive). */
  from: number;
  /** Upper bound in ms (exclusive); null = open-ended. */
  to: number | null;
  count: number;
}

export interface SessionReport {
  schema: "rcai.session-report.v1";
  sessionId: string;
  provider: string | null;
  /** Engine names reported by the provider (local agent: vad/stt/llm/tts). */
  engines: Record<string, string>;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  turns: { user: number; assistant: number; interruptedAssistant: number };
  /** user_speech_ended → assistant_speech_started */
  responseLatency: Summary & { histogram: HistogramBucket[] };
  interruptStop: Summary;
  listeningReact: Summary;
  reconnects: number;
  interruptions: { byUser: number; byAssistant: number };
  /** Late (previous-generation) chunks dropped by the runtime (Gate 1). */
  staleDrops: number;
  stt: Summary;
  llmTtft: Summary;
  ttsTtfa: Summary;
  firstAudio: Summary;
  avatar: { frameIntervalMs: Summary; lipDelayMs: Summary };
  meeting: { connector: string; state: string; botId?: string } | null;
  /** Bounded, untrusted client observations; not authoritative billing totals. */
  usage?: { source: "provider_reported"; observations: { provider: string; model: string; at: number; counters: Record<string, number> }[]; dropped: number };
  errors: { count: number; fatal: number; codes: string[] };
}

export interface TelemetryEnvelope {
  schema: "rcai.telemetry.v1";
  sentAt: number;
  privacyMode: string;
  report: Partial<SessionReport>;
}
