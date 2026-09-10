import { EnergyVAD, LatencyTracker, type AudioSink, type PCMFrame } from "@rcai/audio-core";
import { GENERATION_EVENT_TYPES, type ConversationEvent, type ConversationEventListener, type GenerationRef } from "./events.js";
import type { ConversationContext, SessionConfig } from "./session.js";
import type { SessionRecord, TranscriptTurn } from "./record.js";

/** Minimal structural interface the runtime needs (provider-core's RealtimeAIProvider satisfies it). */
export interface ConversationSource {
  id: string;
  connect(config: SessionConfig): Promise<void>;
  pushAudio(frame: PCMFrame): void;
  sendText(text: string): Promise<void>;
  interrupt(): Promise<void>;
  updateContext(context: ConversationContext): Promise<void>;
  disconnect(): Promise<void>;
  onEvent(callback: ConversationEventListener): void;
  /** Optional: providers whose audio arrives as a MediaStream (WebRTC). */
  getOutputStream?(): MediaStream | null;
  /** Optional: providers that want the raw mic stream (WebRTC) instead of PCM frames. */
  attachInputStream?(stream: MediaStream): void;
  /** Optional: providers that can look at a still image alongside the audio. */
  pushImage?(image: { data: Uint8Array | string; mimeType: string }): void;
  /** Answer a `tool_call`. Providers that do not call tools do not implement it. */
  sendToolResponse?(responses: { id?: string; name: string; response: Record<string, unknown> }[]): void;
}

export type ConversationState = "idle" | "listening" | "thinking" | "speaking" | "interrupted";

export interface ConversationRuntimeOptions {
  /** Where assistant audio goes. Optional for headless/test use. */
  sink?: AudioSink;
  /** Emits user_speech_* locally from mic energy when the provider lacks realtime VAD events, or to beat it. */
  localVad?: boolean | EnergyVAD;
  clock?: () => number;
  sessionId?: string;
}

/**
 * Conversation Runtime (spec §2): owns the provider, normalizes the event stream,
 * tracks state + latency + transcript, and enforces the interruption path
 * (user speech while speaking => sink.interrupt() immediately).
 */
export class ConversationRuntime {
  readonly latency: LatencyTracker;
  private listeners = new Set<ConversationEventListener>();
  private stateListeners = new Set<(state: ConversationState, prev: ConversationState) => void>();
  private _state: ConversationState = "idle";
  private provider: ConversationSource | null = null;
  private config: SessionConfig | null = null;
  private vad: EnergyVAD | null;
  private clock: () => number;
  private record: SessionRecord;
  private currentUser: { text: string; startedAt: number } | null = null;
  private currentAssistant: { text: string; startedAt: number } | null = null;
  private lastAssistantEnd: number | null = null;
  private lastUserEnd: number | null = null;
  private userSpeechFlag = false;
  private micLevelSum = 0;
  private micLevelCount = 0;
  private outputStreamAttached = false;
  private hiddenTexts = new Set<string>();
  /** Generation epoch: events whose generationId is below this are stale and dropped. */
  private acceptedGeneration = 0;
  private currentGen: GenerationRef | null = null;
  private staleListeners = new Set<(e: ConversationEvent, accepted: number) => void>();
  /** Observability counters (Round 3 Gate 1 / Gate 7). */
  readonly stats = { staleDrops: 0, interruptions: 0, generationsCancelled: 0 };

  constructor(private readonly opts: ConversationRuntimeOptions = {}) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.latency = new LatencyTracker(this.clock);
    this.vad = opts.localVad === true ? new EnergyVAD() : opts.localVad instanceof EnergyVAD ? opts.localVad : null;
    this.record = this.newRecord(opts.sessionId ?? `s_${Date.now().toString(36)}`);
  }

  get state(): ConversationState {
    return this._state;
  }

  get currentProvider(): ConversationSource | null {
    return this.provider;
  }

  on(listener: ConversationEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: (state: ConversationState, prev: ConversationState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Debug hook: called for every event dropped as a stale generation (never surfaced to UI listeners). */
  onStaleDrop(listener: (e: ConversationEvent, accepted: number) => void): () => void {
    this.staleListeners.add(listener);
    return () => this.staleListeners.delete(listener);
  }

  /** The generation currently accepted (events below it are dropped). */
  get generation(): { accepted: number; current: GenerationRef | null } {
    return { accepted: this.acceptedGeneration, current: this.currentGen };
  }

  async start(provider: ConversationSource, config: SessionConfig): Promise<void> {
    if (this.provider) await this.stop();
    this.provider = provider;
    this.config = config;
    this.record = this.newRecord(this.record.sessionId, provider.id, config);
    provider.onEvent((e) => this.handleProviderEvent(e));
    await provider.connect(config);
    this.attachOutputStream();
  }

  /** Hot-swap the AI provider without touching avatar/UI (Gate D). */
  async switchProvider(provider: ConversationSource): Promise<void> {
    if (!this.config) throw new Error("runtime not started");
    const config = this.config;
    const old = this.provider;
    this.opts.sink?.interrupt();
    this.opts.sink?.detachStream?.();
    this.outputStreamAttached = false;
    if (old) await old.disconnect().catch(() => {});
    this.setState("idle");
    this.provider = provider;
    this.record.providerId = provider.id;
    this.acceptedGeneration = 0; // a new provider starts its own counters
    this.currentGen = null;
    provider.onEvent((e) => this.handleProviderEvent(e));
    await provider.connect({ ...config, systemPrompt: this.config.systemPrompt });
    this.attachOutputStream();
  }

  async updateContext(context: ConversationContext): Promise<void> {
    if (this.config) this.config = { ...this.config, systemPrompt: context.systemPrompt };
    await this.provider?.updateContext(context);
  }

  /**
   * Send a text turn. `hidden: true` marks control text (e.g. the persona's opening
   * instruction): it is not recorded and a provider echo of the same text is swallowed,
   * so captions/evaluation never see it.
   */
  async sendText(text: string, opts: { hidden?: boolean } = {}): Promise<void> {
    const at = this.clock();
    if (opts.hidden) this.hiddenTexts.add(text.trim());
    else this.record.turns.push({ role: "user", text, startedAt: at, endedAt: at });
    await this.provider?.sendText(text);
  }

  /** Feed mic audio (internal 48k frames). */
  pushMicFrame(frame: PCMFrame): void {
    if (this.vad) {
      for (const ev of this.vad.process(frame)) {
        if (ev.type === "speech_start") this.emitLocal({ type: "user_speech_started", at: ev.timestamp });
        else this.emitLocal({ type: "user_speech_ended", at: ev.timestamp });
      }
      if (this.vad.isSpeaking) {
        this.micLevelSum += this.vad.lastLevelDb;
        this.micLevelCount++;
      }
    }
    this.record.audioMetrics.frames++;
    this.provider?.pushAudio(frame);
  }

  /**
   * A camera frame for the model to look at.
   *
   * Rate-limited by the caller, not here: what is worth showing depends on the conversation (a face
   * during a reply is worth a frame; a face during silence is not), and the runtime does not know
   * that. Providers that cannot take images ignore it — vision is an extra, never a requirement.
   */
  /**
   * Hand a tool's result back to the model. The answer to 「今日のニュースは？」 is only as live as this
   * round trip, so it is a direct call, not a queued event.
   */
  sendToolResponse(responses: { id?: string; name: string; response: Record<string, unknown> }[]): void {
    this.provider?.sendToolResponse?.(responses);
  }

  pushImage(image: { data: Uint8Array | string; mimeType: string }): void {
    this.provider?.pushImage?.(image);
  }

  attachMicStream(stream: MediaStream): void {
    this.provider?.attachInputStream?.(stream);
  }

  /** User-initiated interruption (e.g. tapping the avatar). */
  async interrupt(): Promise<void> {
    this.latency.mark("interrupt_requested");
    const cancelled = this.cancelGeneration();
    this.latency.mark("audio_stopped");
    // Avatar and turn state must stop locally even when the network cancel hangs.
    this.handleProviderEvent({ type: "interrupted", at: this.clock(), gen: cancelled ?? undefined });
    void this.provider?.interrupt().catch(() => {});
  }

  /**
   * Generation cancel (Round 3 Gate 1). Order: (1) provider cancel, (2) accepted generation bump,
   * (3) audio queue / scheduled sources / stream cleared. Late chunks of the old generation are
   * dropped in handleProviderEvent before they can reach the sink, the record, the avatar or the UI.
   * Returns the cancelled generation (or null when the provider never stamped one).
   */
  private cancelGeneration(): GenerationRef | null {
    const cancelled = this.currentGen;
    const next = (cancelled?.generationId ?? 0) + 1;
    if (next > this.acceptedGeneration) this.acceptedGeneration = next;
    this.stats.generationsCancelled++;
    this.opts.sink?.interrupt(this.acceptedGeneration);
    return cancelled;
  }

  async stop(): Promise<SessionRecord> {
    const p = this.provider;
    this.provider = null;
    this.opts.sink?.interrupt();
    this.opts.sink?.detachStream?.();
    this.outputStreamAttached = false;
    if (p) await p.disconnect().catch(() => {});
    this.closeOpenTurns(this.clock());
    this.record.endedAt = this.clock();
    this.setState("idle");
    this.emit({ type: "session_closed" });
    return this.getRecord();
  }

  getRecord(): SessionRecord {
    return JSON.parse(JSON.stringify({
      ...this.record,
      audioMetrics: {
        ...this.record.audioMetrics,
        userLevelDb: this.micLevelCount ? this.micLevelSum / this.micLevelCount : undefined,
      },
    }));
  }

  // ---- internals -------------------------------------------------------

  private attachOutputStream(): void {
    const stream = this.provider?.getOutputStream?.();
    if (stream && this.opts.sink?.attachStream && !this.outputStreamAttached) {
      this.opts.sink.attachStream(stream);
      this.outputStreamAttached = true;
    }
  }

  /** Local VAD events are emitted only if the provider hasn't already told us. */
  private emitLocal(e: ConversationEvent): void {
    if (e.type === "user_speech_started" && this.userSpeechFlag) return;
    if (e.type === "user_speech_ended" && !this.userSpeechFlag) return;
    this.handleProviderEvent(e);
  }

  private handleProviderEvent(e: ConversationEvent): void {
    const at = ("at" in e && typeof e.at === "number" ? e.at : undefined) ?? this.clock();
    // Stale-generation gate: anything produced by a cancelled generation is dropped here, before
    // it can touch the sink, the record, the state machine or any listener (avatar / UI / sidecar).
    if (GENERATION_EVENT_TYPES.has(e.type) && "gen" in e && e.gen) {
      if (e.gen.generationId < this.acceptedGeneration) {
        this.stats.staleDrops++;
        for (const l of this.staleListeners) l(e, this.acceptedGeneration);
        return;
      }
      this.currentGen = e.gen;
    }
    switch (e.type) {
      case "session_ready":
        // Some providers expose their output stream only after connect resolves.
        this.attachOutputStream();
        break;
      case "user_speech_started": {
        if (this.userSpeechFlag) return;
        this.userSpeechFlag = true;
        this.latency.mark("user_speech_started", at);
        if (this.lastAssistantEnd !== null) {
          this.record.timing.userSilencesMs.push(Math.max(0, at - this.lastAssistantEnd));
          this.lastAssistantEnd = null;
        }
        this.currentUser = { text: "", startedAt: at };
        if (this._state === "speaking") {
          // Interruption fast path: cancel the generation and stop local audio before the provider confirms.
          this.latency.mark("interrupt_requested", at);
          const cancelled = this.cancelGeneration();
          this.latency.mark("audio_stopped");
          void this.provider?.interrupt().catch(() => {});
          this.record.interruptions.byUser++;
          this.stats.interruptions++;
          if (this.currentAssistant) {
            this.finishAssistant(at, true);
          }
          this.setState("interrupted");
          this.emit({ type: "interrupted", at, gen: cancelled ?? undefined });
        }
        this.setState("listening");
        break;
      }
      case "user_speech_ended": {
        if (!this.userSpeechFlag) return;
        this.userSpeechFlag = false;
        this.latency.mark("user_speech_ended", at);
        this.lastUserEnd = at;
        if (this.currentUser) {
          this.record.timing.userSpeechDurationsMs.push(at - this.currentUser.startedAt);
        }
        this.setState("thinking");
        break;
      }
      case "user_transcript": {
        if (this.hiddenTexts.has(e.text.trim())) {
          if (e.final !== false) this.hiddenTexts.delete(e.text.trim());
          return; // control text echoed by the provider: not recorded, not emitted
        }
        if (!this.currentUser) this.currentUser = { text: "", startedAt: this.lastUserEnd ?? at };
        if (e.final === false) this.currentUser.text = e.text;
        else {
          this.currentUser.text = e.text;
          this.record.turns.push({ role: "user", text: e.text, startedAt: this.currentUser.startedAt, endedAt: this.lastUserEnd ?? at });
          this.currentUser = null;
        }
        break;
      }
      case "assistant_thinking":
        if (this._state !== "speaking") this.setState("thinking");
        break;
      case "assistant_speech_started": {
        if (this._state === "speaking") return;
        this.latency.mark("assistant_speech_started", at);
        this.opts.sink?.resumeStream?.();
        this.currentAssistant = { text: this.currentAssistant?.text ?? "", startedAt: at };
        this.setState("speaking");
        break;
      }
      case "assistant_audio": {
        if (this._state !== "speaking") {
          // Audio implies speech; providers without explicit start events still get correct state.
          this.handleProviderEvent({ type: "assistant_speech_started", at });
        }
        this.opts.sink?.play(e.frame, e.gen ? { generationId: e.gen.generationId } : undefined);
        break;
      }
      case "assistant_transcript": {
        if (!this.currentAssistant) this.currentAssistant = { text: "", startedAt: at };
        if (e.final === false) this.currentAssistant.text += e.text;
        else this.currentAssistant.text = this.currentAssistant.text && !e.final ? this.currentAssistant.text + e.text : e.text;
        break;
      }
      case "assistant_speech_ended": {
        if (this._state !== "speaking" && !this.currentAssistant) return;
        this.finishAssistant(at, false);
        this.lastAssistantEnd = at;
        this.setState(this.userSpeechFlag ? "listening" : "idle");
        break;
      }
      case "interrupted": {
        // Provider-confirmed interruption (server VAD / explicit cancel). Bump the epoch so any
        // straggler of the cancelled generation is dropped even if the fast path did not run.
        const gen = "gen" in e ? e.gen : undefined;
        const next = (gen?.generationId ?? this.currentGen?.generationId ?? 0) + 1;
        if (next > this.acceptedGeneration) this.acceptedGeneration = next;
        this.opts.sink?.interrupt(this.acceptedGeneration);
        if (this.currentAssistant) this.finishAssistant(at, true);
        if (this._state === "speaking" || this._state === "thinking") {
          if (this._state === "speaking") {
            this.record.interruptions.byUser++;
            this.stats.interruptions++;
          }
          this.setState("interrupted");
          this.setState(this.userSpeechFlag ? "listening" : "idle");
        }
        break;
      }
      case "metrics":
        this.latency.recordBreakdown(e.turn as Record<string, unknown>);
        break;
      case "error":
        break;
      default:
        break;
    }
    this.emit(e);
  }

  private finishAssistant(at: number, interrupted: boolean): void {
    if (!this.currentAssistant) return;
    const turn: TranscriptTurn = {
      role: "assistant",
      text: this.currentAssistant.text,
      startedAt: this.currentAssistant.startedAt,
      endedAt: at,
      interrupted,
    };
    this.record.turns.push(turn);
    this.record.timing.assistantSpeechDurationsMs.push(at - this.currentAssistant.startedAt);
    this.currentAssistant = null;
  }

  private closeOpenTurns(at: number): void {
    if (this.currentUser?.text) {
      this.record.turns.push({ role: "user", text: this.currentUser.text, startedAt: this.currentUser.startedAt, endedAt: at });
    }
    this.currentUser = null;
    if (this.currentAssistant) this.finishAssistant(at, false);
    const rl = this.latency.getSamples("turn_response").map((s) => s.ms);
    this.record.timing.responseLatenciesMs = rl;
  }

  private setState(next: ConversationState): void {
    const prev = this._state;
    if (prev === next) return;
    this._state = next;
    for (const l of this.stateListeners) l(next, prev);
  }

  private emit(e: ConversationEvent): void {
    for (const l of this.listeners) l(e);
  }

  private newRecord(sessionId: string, providerId = "none", config?: SessionConfig): SessionRecord {
    return {
      sessionId,
      providerId,
      mode: config?.mode ?? "free_talk",
      characterId: config?.characterId,
      personaId: config?.personaId,
      language: config?.language ?? "ja-JP",
      startedAt: this.clock(),
      turns: [],
      timing: { responseLatenciesMs: [], userSilencesMs: [], userSpeechDurationsMs: [], assistantSpeechDurationsMs: [] },
      interruptions: { byUser: 0, byAssistant: 0 },
      audioMetrics: { frames: 0 },
    };
  }
}
