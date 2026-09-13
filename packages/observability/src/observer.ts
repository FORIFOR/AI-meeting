import type { ConversationEvent } from "@rcai/conversation-core";
import type { PCMFrame } from "@rcai/audio-core";
import { histogram, Samples } from "./stats.js";
import type { SessionReport, Summary } from "./types.js";

export interface SessionObserverOptions {
  sessionId: string;
  clock?: () => number;
  provider?: string | null;
}

const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}` : "–");

/**
 * Aggregates the unified event stream (plus a few explicit notes) into a SessionReport.
 * It never stores transcript text — only counts and timings — so a report is telemetry-safe by construction.
 */
export class SessionObserver {
  readonly sessionId: string;
  private clock: () => number;
  private provider: string | null;
  private engines: Record<string, string> = {};
  private startedAt: number;
  private endedAt: number | null = null;
  private turnsUser = 0;
  private turnsAssistant = 0;
  private interruptedAssistant = 0;
  private response = new Samples();
  private subtitleArrival = new Samples();
  private playbackSignal = new Samples();
  private interruptionSilence = new Samples();
  private subtitleFrom: number | null = null;
  private playbackFrom: number | null = null;
  private playbackArmed = false;
  private stopFrom: number | null = null;
  private quietMs = 0;
  private lastSignalAt = -Infinity;
  private stopCandidate: number | null = null;
  private interruptionEventAt = -Infinity;
  private interruptStop = new Samples();
  private listeningReact = new Samples();
  private stt = new Samples();
  private llmTtft = new Samples();
  private ttsTtfa = new Samples();
  private firstAudio = new Samples();
  private frameInterval = new Samples(2000);
  private lipDelay = new Samples(500);
  private reconnects = 0;
  private readyCount = 0;
  private interruptionsByUser = 0;
  private interruptionsByAssistant = 0;
  private staleDrops = 0;
  private usage: NonNullable<SessionReport["usage"]> = { source: "provider_reported", observations: [], dropped: 0 };
  private errors = 0;
  private fatal = 0;
  private errorCodes: string[] = [];
  private meeting: SessionReport["meeting"] = null;
  private lastUserEnd: number | null = null;
  private lastUserStart: number | null = null;
  private lastInterruptAt: number | null = null;
  private speaking = false;
  private assistantOpen = false;

  constructor(opts: SessionObserverOptions) {
    this.sessionId = opts.sessionId;
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.provider = opts.provider ?? null;
    this.startedAt = this.clock();
  }

  setProvider(id: string): void {
    this.provider = id;
  }

  /** Feed every ConversationEvent. Timestamps come from `event.at` when present. */
  handleEvent(e: ConversationEvent): void {
    const at = ("at" in e && typeof e.at === "number" ? e.at : undefined) ?? this.clock();
    switch (e.type) {
      case "session_ready":
        this.readyCount++;
        if (this.readyCount > 1) this.reconnects++;
        if (e.providerId) this.provider = e.providerId;
        break;
      case "user_speech_started":
        // A new user turn supersedes an unanswered one. Never pair a late response with it.
        this.subtitleFrom = this.playbackFrom = null;
        this.lastUserEnd = null;
        this.playbackArmed = false;
        this.stopCandidate = at - this.lastSignalAt >= 0 && at - this.lastSignalAt <= 100 ? at : null;
        // The runtime can emit its interruption immediately before the matching speech-start.
        this.stopFrom = this.interruptionEventAt === at ? this.stopCandidate : null;
        this.quietMs = 0;
        this.lastUserStart = at;
        if (this.speaking) {
          this.interruptionsByUser++;
          this.lastInterruptAt = at;
        }
        break;
      case "user_speech_ended":
        this.lastUserEnd = at;
        this.subtitleFrom = this.playbackFrom = at;
        break;
      case "user_transcript":
        if (e.final !== false && e.text.trim()) this.turnsUser++;
        break;
      case "assistant_speech_started":
        this.stopCandidate = this.stopFrom = null;
        if (this.lastUserEnd !== null) {
          if (at >= this.lastUserEnd) this.response.push(at - this.lastUserEnd);
          this.lastUserEnd = null;
        }
        this.playbackArmed = true;
        this.speaking = true;
        this.assistantOpen = true;
        break;
      case "assistant_audio":
        this.speaking = true;
        this.assistantOpen = true;
        break;
      case "assistant_transcript":
        if (e.text.trim() && this.subtitleFrom !== null && at >= this.subtitleFrom) {
          this.subtitleArrival.push(at - this.subtitleFrom);
          this.subtitleFrom = null;
        }
        break;
      case "assistant_speech_ended":
        if (this.assistantOpen) this.turnsAssistant++;
        this.assistantOpen = false;
        this.speaking = false;
        break;
      case "interrupted":
        this.interruptionEventAt = at;
        if (this.stopCandidate !== null && at >= this.stopCandidate) this.stopFrom = this.stopCandidate;
        this.subtitleFrom = this.playbackFrom = null;
        this.playbackArmed = false;
        if (this.assistantOpen) {
          this.turnsAssistant++;
          this.interruptedAssistant++;
        }
        this.assistantOpen = false;
        this.speaking = false;
        break;
      case "usage":
        if (this.usage.observations.length < 256) this.usage.observations.push({ provider: e.provider, model: e.model, at: e.at, counters: { ...e.counters } });
        else this.usage.dropped++;
        break;
      case "metrics": {
        const t = e.turn;
        if (typeof t.sttMs === "number") this.stt.push(t.sttMs);
        if (typeof t.llmTtftMs === "number") this.llmTtft.push(t.llmTtftMs);
        if (typeof t.ttsTtfaMs === "number") this.ttsTtfa.push(t.ttsTtfaMs);
        if (typeof t.firstAudioSentMs === "number") this.firstAudio.push(t.firstAudioSentMs);
        if (t.engines) for (const [k, v] of Object.entries(t.engines as Record<string, string | undefined>)) if (v) this.engines[k] = v;
        break;
      }
      case "error":
        this.errors++;
        if (e.fatal) this.fatal++;
        this.noteErrorCode(e.error);
        break;
      case "session_closed":
        this.endedAt = at;
        break;
      default:
        break;
    }
  }

  /** Post-gain AudioWorklet PCM observed on the main thread; includes tap delivery delay.
   * Silence = peak <= 0.001 for >= 30 ms. Does not include speaker/Bluetooth hardware latency.
   */
  notePlaybackFrame(frame: PCMFrame, at = this.clock()): void {
    if (this.endedAt !== null || !frame.data.length || !Number.isFinite(at) || frame.sampleRate <= 0) return;
    let peak = 0;
    for (const sample of frame.data) peak = Math.max(peak, Math.abs(sample));
    if (peak > 0.001) {
      this.lastSignalAt = at;
      this.quietMs = 0;
      if (this.playbackArmed && this.playbackFrom !== null && at >= this.playbackFrom) {
        this.playbackSignal.push(at - this.playbackFrom);
        this.playbackFrom = null;
      }
    } else if (this.stopFrom !== null) {
      this.quietMs += frame.data.length / frame.sampleRate * 1000;
      if (this.quietMs >= 30 && at >= this.stopFrom) {
        this.interruptionSilence.push(at - this.stopFrom);
        this.stopFrom = null;
        this.stopCandidate = null;
      }
    }
  }

  /** Runtime-side marks (from LatencyTracker) when available. */
  noteLatencySample(name: "interrupt_stop" | "listening_react" | "turn_response", ms: number): void {
    if (name === "interrupt_stop") this.interruptStop.push(ms);
    else if (name === "listening_react") this.listeningReact.push(ms);
    else this.response.push(ms);
  }

  noteReconnect(): void {
    this.reconnects++;
  }

  noteStaleDrops(total: number): void {
    this.staleDrops = Math.max(this.staleDrops, total);
  }

  noteAssistantInterruption(): void {
    this.interruptionsByAssistant++;
  }

  noteError(codeOrError: string | Error, fatal = false): void {
    this.errors++;
    if (fatal) this.fatal++;
    this.noteErrorCode(codeOrError);
  }

  noteFrameInterval(ms: number): void {
    this.frameInterval.push(ms);
  }

  noteLipDelay(ms: number): void {
    this.lipDelay.push(ms);
  }

  setMeetingState(connector: string, state: string, botId?: string): void {
    this.meeting = { connector, state, botId };
  }

  end(at: number = this.clock()): void {
    this.endedAt = at;
  }

  toReport(): SessionReport {
    const now = this.endedAt ?? this.clock();
    const response = this.response.all();
    return {
      schema: "rcai.session-report.v1",
      usage: { ...this.usage, observations: this.usage.observations.map(x => ({ ...x, counters: { ...x.counters } })) },
      sessionId: this.sessionId,
      provider: this.provider,
      engines: { ...this.engines },
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: Math.max(0, now - this.startedAt),
      turns: { user: this.turnsUser, assistant: this.turnsAssistant, interruptedAssistant: this.interruptedAssistant },
      responseLatency: { ...this.response.summary(), histogram: histogram(response) },
      browserTiming: {
        schema: "rcai.browser-timing.v1",
        subtitleArrival: this.subtitleArrival.summary(),
        playbackSignal: this.playbackSignal.summary(),
        interruptionSilence: this.interruptionSilence.summary(),
        samples: { subtitleArrival: this.subtitleArrival.all(), playbackSignal: this.playbackSignal.all(), interruptionSilence: this.interruptionSilence.all() },
        dropped: { subtitleArrival: this.subtitleArrival.dropped, playbackSignal: this.playbackSignal.dropped, interruptionSilence: this.interruptionSilence.dropped },
      },
      interruptStop: this.interruptStop.summary(),
      listeningReact: this.listeningReact.summary(),
      reconnects: this.reconnects,
      interruptions: { byUser: this.interruptionsByUser, byAssistant: this.interruptionsByAssistant },
      staleDrops: this.staleDrops,
      stt: this.stt.summary(),
      llmTtft: this.llmTtft.summary(),
      ttsTtfa: this.ttsTtfa.summary(),
      firstAudio: this.firstAudio.summary(),
      avatar: { frameIntervalMs: this.frameInterval.summary(), lipDelayMs: this.lipDelay.summary() },
      meeting: this.meeting,
      errors: { count: this.errors, fatal: this.fatal, codes: [...this.errorCodes] },
    };
  }

  toMarkdown(): string {
    return reportToMarkdown(this.toReport());
  }

  private noteErrorCode(e: string | Error): void {
    const msg = typeof e === "string" ? e : e.message;
    // Only a code-like token is kept (never a message that could carry user text).
    const code = /BLOCKED_BY_[A-Z_]+|[A-Z][A-Z0-9_]{3,}/.exec(msg)?.[0] ?? (typeof e === "string" ? "ERROR" : e.name || "ERROR");
    if (this.errorCodes.length < 50) this.errorCodes.push(code);
  }
}

function row(label: string, s: Summary, unit = "ms"): string {
  return `| ${label} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} ${unit} | ${s.count} |`;
}

export function reportToMarkdown(r: SessionReport): string {
  const lines = [
    `# Session report ${r.sessionId}`,
    ``,
    `provider: **${r.provider ?? "—"}** · engines: ${Object.entries(r.engines).map(([k, v]) => `${k}=${v}`).join(", ") || "—"} · duration: ${(r.durationMs / 60000).toFixed(1)} min`,
    `turns: user ${r.turns.user} / assistant ${r.turns.assistant} (interrupted ${r.turns.interruptedAssistant}) · reconnects: ${r.reconnects} · barge-ins: ${r.interruptions.byUser} · stale drops: ${r.staleDrops} · errors: ${r.errors.count} (fatal ${r.errors.fatal})`,
    r.meeting ? `meeting: ${r.meeting.connector} · ${r.meeting.state}${r.meeting.botId ? ` · bot ${r.meeting.botId}` : ""}` : "",
    ``,
    `| metric | p50 | p95 | p99 | max | n |`,
    `|---|---|---|---|---|---|`,
    row("response (user end → assistant start)", r.responseLatency),
    row("speech end → subtitle event (not display paint)", r.browserTiming.subtitleArrival),
    row("speech end → output PCM signal (not hardware)", r.browserTiming.playbackSignal),
    row("interruption → output PCM silence (30 ms confirmation)", r.browserTiming.interruptionSilence),
    row("barge-in stop command (not observed silence)", r.interruptStop),
    row("→ listening", r.listeningReact),
    row("STT", r.stt),
    row("LLM TTFT", r.llmTtft),
    row("TTS TTFA", r.ttsTtfa),
    row("first audio (agent)", r.firstAudio),
    row("avatar frame interval", r.avatar.frameIntervalMs),
    row("lip delay (audio → mouth)", r.avatar.lipDelayMs),
    ``,
    `response histogram: ${r.responseLatency.histogram.map((b) => `${b.from}${b.to === null ? "+" : `-${b.to}`}:${b.count}`).join("  ")}`,
  ];
  return lines.filter((l) => l !== undefined).join("\n");
}
