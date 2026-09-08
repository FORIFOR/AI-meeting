import { configureSessionTools, TaskTranscript } from "./sessionTools.js";
import { TASK_TOOL, USER_CONTEXT_TOOL, TaskLedger, type ConversationTask, type TaskProposal } from "@rcai/conversation-core";
import { LIVE_LOOKUP_TOOL, currentNewsOnly, parseLookupArguments, renderLookup, type LiveLookupResult } from "@rcai/meeting-core";
import { MicCapture, SpeakerOutput, dbfs, rms, type LatencyTracker } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationEvent, type SessionRecord } from "@rcai/conversation-core";
import type { ProviderId } from "@rcai/conversation-core";
import type { EvaluationResult } from "@rcai/provider-core";
import { AvatarRuntime, loadCharacter, type AvatarProvider, type CharacterDefinition, type Emotion, type StateTransition } from "@rcai/avatar-core";
import { BehaviorEngine, RemoteSemanticPlanner } from "@rcai/behavior-engine";
import { createSessionConfig, type Persona } from "@rcai/persona-core";
import { createAvatarProvider, createConversationProvider, createEvaluator, createHeuristicEvaluator, plannerUrl, type CharacterEntry } from "../integrations/registry.js";
import { chosenVoice, decide, type Availability, type Settings } from "../state/settings.js";
import { EvaluationSidecar, type DeferredFeedback } from "./sidecar.js";
import { SessionObserver, createTelemetrySender, type SessionReport } from "@rcai/observability";
import { IncidentRecorder, submitIncident, saveIncidentMeta, type IncidentOptIn, type PresenceIncident } from "./IncidentRecorder.js";
import { setActiveSession } from "./activeSession.js";

/** Thrown by `start()` when `dispose()` ran while it was still awaiting something. */
export class SessionDisposedError extends Error {
  constructor() {
    super("session disposed");
    this.name = "SessionDisposedError";
  }
}

export interface SessionHandlers {
  onEvent(e: ConversationEvent): void;
  onAvatarState(t: StateTransition): void;
  onError(message: string, code?: string): void;
  onProviderChange(id: ProviderId): void;
  onDeferred?(f: DeferredFeedback): void;
  onLookup?(result: LiveLookupResult): void;
  onTasks?(tasks: ConversationTask[]): void;
  onTaskProposals?(proposals: TaskProposal[]): void;
}

export interface SessionInit {
  settings: Settings;
  availability: Availability;
  persona: Persona;
  character: CharacterEntry;
  params: Record<string, string>;
  stage: HTMLElement;
  handlers: SessionHandlers;
}

export interface SessionOutcome {
  tasks?: ConversationTask[];
  record: SessionRecord;
  evaluation: EvaluationResult | null;
  evaluationError?: string;
  fallbackUsed: boolean;
  deferred: DeferredFeedback[];
  providerId: ProviderId;
  latency: ReturnType<LatencyTracker["report"]>;
  /** Round 3 Gate 7: numbers-only session report (telemetry-safe by construction). */
  report: SessionReport | null;
  /** Round 3 Gate 6: presence incidents captured during the session (media only if opted in). */
  incidents: PresenceIncident[];
  telemetry?: "sent" | "skipped-strict" | "failed";
}

/**
 * Owns the whole live path: Mic → ConversationRuntime → Provider → ConversationEvent →
 * { SpeakerOutput, AvatarRuntime, BehaviorEngine, EvaluationSidecar }. The UI only sees events.
 */
export class SessionController {
  private tasks = new TaskLedger();
  private taskSource = new TaskTranscript();
  private speaker: SpeakerOutput | null = null;
  private mic: MicCapture | null = null;
  private runtime: ConversationRuntime | null = null;
  private avatarRuntime: AvatarRuntime | null = null;
  private avatar: AvatarProvider | null = null;
  private behavior: BehaviorEngine | null = null;
  private sidecar: EvaluationSidecar | null = null;
  private character: CharacterDefinition | null = null;
  private observer: SessionObserver | null = null;
  private recorder: IncidentRecorder | null = null;
  private lastLatencyCounts = { interrupt_stop: 0, listening_react: 0 };
  private _providerId: ProviderId;
  private decision: ReturnType<typeof decide>;
  private disposed = false;
  private started = false;
  /** Aborted by dispose(); every async step of start() checks it after awaiting (docs/audio-lifecycle.md). */
  private readonly abort = new AbortController();
  private disposing: Promise<void> | null = null;

  constructor(private readonly init: SessionInit) {
    this.decision = decide(init.settings, init.availability);
    this._providerId = this.decision.conversation;
  }

  get providerId(): ProviderId {
    return this._providerId;
  }

  get latency(): LatencyTracker | null {
    return this.runtime?.latency ?? null;
  }

  get avatarState() {
    return this.avatarRuntime?.state ?? "IDLE";
  }

  private get factoryOptions() {
    const { settings } = this.init;
    return { brokerUrl: settings.brokerUrl, agentUrl: settings.agentUrl, privacyMode: settings.privacyMode };
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  private checkpoint(): void {
    if (this.abort.signal.aborted) throw new SessionDisposedError();
  }

  /**
   * Builds the live path. If `dispose()` is called while this is running (React StrictMode
   * double-mount, route change, page unload) it stops at the next checkpoint, releases everything it
   * created so far and rejects with `SessionDisposedError` — never leaving an AudioContext or a
   * MediaStreamTrack behind and never surfacing an unhandled rejection.
   */
  async start(): Promise<void> {
    if (this.started) throw new Error("session already started");
    this.started = true;
    this.checkpoint();
    setActiveSession(this);
    try {
      await this.build();
    } catch (err) {
      // Release partially-created resources in the documented order, then rethrow.
      await this.teardown();
      throw err;
    }
  }

  private async build(): Promise<void> {
    const { settings, persona, character, stage, handlers, params } = this.init;

    // 1. Audio output first: the user gesture that started the session unlocks the AudioContext.
    const speaker = new SpeakerOutput();
    this.speaker = speaker;
    await speaker.resume();
    await speaker.whenReady();
    this.checkpoint();
    // setSinkId only after the worklet is wired (changing the sink mid-load is unnecessary churn).
    if (settings.outputDeviceId && "setSinkId" in speaker.context) {
      await (speaker.context as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(settings.outputDeviceId).catch(() => {});
      this.checkpoint();
    }

    // 2. Conversation runtime with local VAD (fast LISTENING path, <100 ms).
    const runtime = new ConversationRuntime({ sink: speaker, localVad: true });
    this.runtime = runtime;

    // 2b. Observability (Gate 7) + presence incident ring buffer (Gate 6). Both are passive observers.
    const observer = new SessionObserver({ sessionId: runtime.getRecord().sessionId, provider: this.decision.conversation });
    this.observer = observer;
    const recorder = new IncidentRecorder({
      sessionId: () => runtime.getRecord().sessionId,
      observer,
      getHud: () => ({ latency: runtime.latency.report(), breakdown: runtime.latency.breakdownSummary() }),
      getProvider: () => this._providerId,
      getAvatarState: () => this.avatarState,
      getVideoElement: () => (typeof document !== "undefined" ? document.querySelector<HTMLVideoElement>(".pip video") : null),
      meta: { mode: persona.mode, characterId: character.id },
    });
    this.recorder = recorder;

    // 3. Avatar (renderer chosen by the character pack; never by the AI provider).
    const def = await this.resolveCharacter(character);
    this.checkpoint();
    this.character = def;
    const rawAvatar = await createAvatarProvider(character.renderer, { container: stage, brokerUrl: settings.brokerUrl, privacyMode: settings.privacyMode });
    this.checkpoint();
    const avatar = recorder.wrapAvatar(rawAvatar); // logs emotion/gesture/gaze calls for incidents; behaviour unchanged
    this.avatar = avatar;
    await avatar.prepare(def);
    this.checkpoint();
    const avatarRuntime = new AvatarRuntime(avatar, { latency: runtime.latency });
    this.avatarRuntime = avatarRuntime;
    avatarRuntime.onStateChange((t) => {
      recorder.recordState(t);
      handlers.onAvatarState(t);
    });
    await avatar.start();
    recorder.startProbe(rawAvatar);
    this.checkpoint();

    // 4. Behavior engine (fast tier + async semantic planner; never blocks audio).
    const planner = new RemoteSemanticPlanner(plannerUrl(this.decision.conversation, this.factoryOptions), 1500);
    const interview = persona.mode === "interview";
    const behavior = new BehaviorEngine(avatarRuntime, {
      planner,
      mode: persona.mode,
      baseEmotion: (persona.defaultEmotion as Emotion | undefined) ?? (interview ? "neutral" : "warm_positive"),
      baseEmotionIntensity: interview ? 0.15 : 0.3,
    });
    this.behavior = behavior;
    behavior.start();

    // 5. Evaluator sidecar (off the latency path).
    const sidecar = new EvaluationSidecar({
      enableDeferred: persona.mode === "english_lesson",
      deferredEveryTurns: 4,
      evaluator: () => createEvaluator(this.decision.evaluation, this.factoryOptions),
      fallback: () => createHeuristicEvaluator(),
      getRecord: () => runtime.getRecord(),
      params,
      evaluationProfile: persona.evaluationProfile,
      onDeferred: (f) => handlers.onDeferred?.(f),
      onError: (e) => handlers.onError(e instanceof Error ? e.message : String(e), "EVALUATION"),
    });
    this.sidecar = sidecar;

    // 6. Fan-out of unified events + played audio.
    speaker.tap.subscribe((frame) => {
      avatarRuntime.pushAudio(frame);
      recorder.recordAssistantFrame(frame);
    });
    runtime.on((e) => {
      avatarRuntime.handleEvent(e);
      behavior.handleEvent(e);
      sidecar.handleEvent(e);
      observer.handleEvent(e);
      recorder.recordEvent(e);
      if (e.type === "interrupted" || e.type === "assistant_speech_ended") this.syncLatencyNotes();
      // A provider that says "rotating, reconnecting" is doing its job; only a failure the user can act
      // on becomes a toast. Non-fatal notices stay in the incident record, which is where they belong.
      if (e.type === "error" && e.fatal !== false) handlers.onError(e.error.message, "PROVIDER");
      if (e.type === "user_speech_started") this.taskSource.start();
      if (e.type === "user_transcript") this.taskSource.update(e.text, e.final);
      if (persona.mode === "task_planning" && e.type === "tool_call" && e.call.name === TASK_TOOL.name) {
        void this.recordTaskCall(e.call);
      }
      if ((persona.mode === "career" || persona.mode === "interview") && e.type === "tool_call" && e.call.name === USER_CONTEXT_TOOL.name) {
        const statements = runtime.getRecord().turns.filter(t=>t.role === "user").slice(-20).map(t=>t.text);
        runtime.sendToolResponse([{id:e.call.id,name:e.call.name,response:{statements,priority:"Latest correction and constraints take precedence. Do not invent unspoken experience."}}]);
      }
      handlers.onEvent(e);
      if (e.type === "tool_call" && e.call.name === LIVE_LOOKUP_TOOL.name) void this.lookup(e.call);
    });

    // 7. Microphone → runtime (48k frames) + behavior energy.
    const mic = new MicCapture({ context: speaker.context, deviceId: settings.inputDeviceId });
    this.mic = mic;
    const stream = await mic.start();
    this.checkpoint();
    mic.onFrame((frame) => {
      runtime.pushMicFrame(frame);
      recorder.recordMicFrame(frame);
      const db = dbfs(rms(frame.data));
      behavior.reportUserAudio(Math.max(0, Math.min(1, (db + 50) / 35)), frame.timestamp);
    });

    // 8. AI provider (routed) + session config (persona + character + policy; no secrets).
    const provider = await createConversationProvider(this.decision.conversation, this.factoryOptions);
    this.checkpoint();
    const config = createSessionConfig({ persona, character: def, providerId: this.decision.conversation, privacyMode: settings.privacyMode, params, voiceId: chosenVoice(settings, def?.manifest.id, this.decision.conversation) });
    configureSessionTools(config, provider.capabilities().toolCalling);
    await runtime.start(provider, config);
    this.checkpoint();
    runtime.attachMicStream(stream);
    recorder.recordProvider(this._providerId);
    handlers.onProviderChange(this._providerId);

    // 9. Opening line: owned by the provider (config.providerOptions.opening) — each adapter starts it natively
    //    (OpenAI response.create, Local agent TTS, Gemini hidden client turn). Nothing to send here.
  }

  private async recordTaskCall(call: {id?:string;name:string;arguments:Record<string,unknown>}): Promise<void> {
    // Live audio may deliver the tool call before its transcription has caught up.
    // Never relax quote validation; briefly wait for the actual user transcript instead.
    let result = this.tasks.apply(call.arguments, this.taskSource.text());
    const deadline = Date.now() + 1200;
    while (result.error === "quote must occur in the latest user statement" && Date.now() < deadline && !this.disposed) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (this.disposed) return;
      result = this.tasks.apply(call.arguments, this.taskSource.text());
    }
    if (this.disposed) return;
    if (result.error === "quote must occur in the latest user statement") {
      const pending = this.tasks.propose(call.arguments);
      if (pending.proposal) {
        this.init.handlers.onTaskProposals?.(this.tasks.pending());
        this.runtime?.sendToolResponse([{id:call.id,name:call.name,response:{tasks:result.tasks,status:'needs_user_confirmation',proposal:pending.proposal,instruction:'変更は未実行です。聞き取りを確認できなかったため、画面の「この変更を反映」で確認をお願いしてください。完了・記録済みとは言わず、同じ操作を繰り返さない。'}}]);
        return;
      }
    }
    if (result.error) this.init.handlers.onError("タスクの変更を確認できませんでした。変更内容をもう一度伝えてください。", "TASK_RECORD");
    this.init.handlers.onTasks?.(result.tasks);
    this.runtime?.sendToolResponse([{id:call.id,name:call.name,response:result}]);
  }

  resolveTaskProposal(id: string, accept: boolean): void {
    if (this.disposed) return;
    const result=this.tasks.resolve(id,accept);
    this.init.handlers.onTaskProposals?.(this.tasks.pending());
    this.init.handlers.onTasks?.(result.tasks);
    if(result.error) { this.init.handlers.onError("タスクの状態が変わりました。変更をもう一度伝えてください。", "TASK_RECORD"); return; }
    // A UI correction must not inject a competing turn while the microphone is active.
    // The model reads the current ledger through session_tasks before its next summary.
  }

  private async lookup(call: { id?: string; name: string; arguments: Record<string, unknown> }): Promise<void> {
    if (this.disposed || this.init.settings.privacyMode === "strict_local") return;
    const req = parseLookupArguments(call.arguments);
    let result: LiveLookupResult = { facts: [], at: new Date().toISOString(), error: "invalid lookup arguments" };
    try {
      if (req) {
        const response = await fetch(`${this.init.settings.brokerUrl.replace(/\/$/, "")}/api/lookup`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req),
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw new Error("lookup unavailable");
        result = await response.json() as LiveLookupResult;
        if (!Array.isArray(result.facts) || typeof result.at !== "string") throw new Error("invalid lookup response");
        if (req.kind === "news" && !result.articles?.length) result = { facts: [], at: result.at, error: "No news with publication dates and sources was found" };
      }
    } catch { result = { facts: [], at: new Date().toISOString(), error: "Live information is unavailable; do not invent it" }; }
    if (this.disposed) return;
    result = currentNewsOnly(result);
    this.init.handlers.onLookup?.(result);
    this.runtime?.sendToolResponse([{ id: call.id, name: call.name, response: renderLookup(result) }]);
  }

  /** Gate D: swap the AI provider; avatar/UI untouched. */
  async switchProvider(id: ProviderId): Promise<void> {
    if (!this.runtime) throw new Error("session not started");
    if (this.init.settings.privacyMode === "strict_local" && id !== "local") throw new Error("BLOCKED_BY_STRICT_LOCAL");
    const provider = await createConversationProvider(id, this.factoryOptions);
    await this.runtime.switchProvider(provider);
    const stream = this.mic?.mediaStream;
    if (stream) this.runtime.attachMicStream(stream);
    this._providerId = id;
    this.observer?.setProvider(id);
    this.recorder?.recordProvider(id);
    this.init.handlers.onProviderChange(id);
  }

  // ---- Round 3 Gate 6/7 surface -------------------------------------------------------------
  /** 「不自然だった瞬間」: freeze ±5 s of presence context into one incident (media only when opted in). */
  captureIncident(reason = "不自然だった瞬間", note?: string): PresenceIncident | null {
    const rec = this.recorder;
    if (!rec) return null;
    const incident = rec.capture(reason, note);
    // Complete the +5 s half of the window, then persist/submit (never under strict_local).
    setTimeout(() => {
      const full = rec.complete(incident);
      saveIncidentMeta(rec.incidents);
      void submitIncident(this.init.settings.brokerUrl, this.init.settings.privacyMode, full).then((r) => {
        if (r === "failed") this.init.handlers.onError("incident could not be sent to the broker (kept locally)", "INCIDENT");
      });
    }, 5200);
    return incident;
  }

  setIncidentOptIn(next: Partial<IncidentOptIn>): void {
    this.recorder?.setOptIn(next);
  }

  get incidentOptIn(): IncidentOptIn {
    return this.recorder?.optInState ?? { audio: false, video: false };
  }

  get incidents(): PresenceIncident[] {
    return this.recorder?.incidents ?? [];
  }

  /** Live numbers for the HUD; never contains text. */
  observabilityReport(): SessionReport | null {
    this.syncLatencyNotes();
    return this.observer?.toReport() ?? null;
  }

  /** Copy runtime LatencyTracker samples (interrupt/listening) + stale drops into the observer. */
  private syncLatencyNotes(): void {
    const rt = this.runtime;
    const obs = this.observer;
    if (!rt || !obs) return;
    for (const name of ["interrupt_stop", "listening_react"] as const) {
      const samples = rt.latency.getSamples(name);
      for (let i = this.lastLatencyCounts[name]; i < samples.length; i++) {
        obs.noteLatencySample(name, samples[i]!.ms);
        this.recorder?.recordLatency(name, samples[i]!.ms);
      }
      this.lastLatencyCounts[name] = samples.length;
    }
    const stats = (rt as unknown as { stats?: { staleDrops?: number } }).stats;
    if (typeof stats?.staleDrops === "number") obs.noteStaleDrops(stats.staleDrops);
  }

  async interrupt(): Promise<void> {
    await this.runtime?.interrupt();
  }

  setMuted(muted: boolean): void {
    this.mic?.setMuted(muted);
  }

  get isMuted(): boolean {
    return this.mic?.isMuted ?? false;
  }

  latencyReport() {
    return this.runtime?.latency.report() ?? null;
  }

  async end(): Promise<SessionOutcome> {
    if (!this.runtime) throw new Error("session not started");
    const runtime = this.runtime;
    const record = await runtime.stop();
    const latency = runtime.latency.report();
    this.syncLatencyNotes();
    this.observer?.end();
    const report = this.observer?.toReport() ?? null;
    const incidents = [...(this.recorder?.incidents ?? [])];
    saveIncidentMeta(incidents);
    await this.teardown();
    // Telemetry: numbers only; a strict_local session never touches the network here.
    let telemetry: SessionOutcome["telemetry"];
    if (report) telemetry = await createTelemetrySender({ brokerUrl: this.init.settings.brokerUrl, privacyMode: this.init.settings.privacyMode }).send(report);

    let evaluation: EvaluationResult | null = null;
    let evaluationError: string | undefined;
    let fallbackUsed = false;
    if (record.mode !== "companion" && record.mode !== "task_planning") try {
      const out = await this.sidecar!.finalize(record);
      evaluation = out.result;
      fallbackUsed = out.fallbackUsed;
      evaluationError = out.error;
    } catch (err) {
      evaluationError = err instanceof Error ? err.message : String(err);
    }
    return { tasks: this.tasks.snapshot(), record, evaluation, evaluationError, fallbackUsed, deferred: this.sidecar?.deferred ?? [], providerId: this._providerId, latency, report, incidents, telemetry };
  }

  /** Idempotent; safe during start(). Order: abort → mic tracks → runtime/provider → avatar → speaker/context. */
  dispose(): Promise<void> {
    if (!this.disposing) this.disposing = this.teardown();
    return this.disposing;
  }

  private async teardown(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    setActiveSession(null);
    this.behavior?.stop();
    this.behavior = null;
    this.recorder?.dispose(); // stops the rAF/interval probes; ring buffers are dropped
    // 1. Stop capture first so no frame reaches a provider that is going away.
    await this.mic?.stop().catch(() => {});
    // 2. Provider / runtime (closes sockets, peer connections; sink is interrupted inside).
    await this.runtime?.stop().catch(() => {});
    // 3. Renderer.
    await this.avatarRuntime?.dispose().catch(() => {});
    if (!this.avatarRuntime && this.avatar) await this.avatar.stop().catch(() => {});
    // 4. Output nodes + the shared AudioContext (owned by the speaker).
    await this.speaker?.close().catch(() => {});
    this.mic = null;
    this.avatarRuntime = null;
    this.avatar = null;
    this.speaker = null;
  }

  private async resolveCharacter(entry: CharacterEntry): Promise<CharacterDefinition> {
    if (entry.renderer === "live2d" || entry.renderer === "vrm" || entry.renderer === "canvas") {
      return loadCharacter(entry.baseUrl);
    }
    // Cloud avatars: identity only; the vendor owns model/animation (spec §17).
    return {
      manifest: { id: entry.id, name: entry.name, renderer: entry.renderer, defaultPersona: entry.defaultPersona ?? "friendly", supportedLanguages: ["ja-JP", "en-US"], motionProfile: "vendor", voiceProfiles: [] },
      baseUrl: entry.baseUrl,
      model: entry.id,
      expressions: {},
      motions: {},
      voice: { characterId: entry.id, voices: {} },
    };
  }
}
