import { geminiUsageCounters, LiveUsageAccumulator } from "./usage.js";
import {
  AudioNormalizer,
  EnergyVAD,
  OutboundAudioConverter,
  base64ToBytes,
  bytesToBase64,
  bytesToInt16,
  int16ToBytes,
  int16ToFloat32,
  type ImageFrame,
  type PCMFrame,
  dbfs,
  rms,
} from "@rcai/audio-core";
import { GenerationCounter,
  conversationPolicyFor,
  type ConversationContext,
  type ConversationEvent,
  type ConversationEventListener,
  type SessionConfig,
} from "@rcai/conversation-core";
import { privacyGuard, type ProviderCapabilities, type RealtimeAIProvider } from "@rcai/provider-core";
import { geminiPromptAdapter } from "./promptAdapter.js";
import {
  DEFAULT_GEMINI_LIVE_MODEL,
  DEFAULT_GEMINI_LIVE_VOICE,
  GEMINI_INPUT_RATE,
  geminiWssUrl,
  parsePcmRate,
  type AutomaticActivityDetection,
  type GeminiClientMessage,
  type GeminiServerMessage,
  type GeminiSetup,
} from "./protocol.js";

/** Minimal WebSocket surface so tests can inject a fake and node/browser both work. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export interface GeminiTokenResponse {
  backend?: "developer" | "vertex";
  websocketPath?: string;
  token: string;
  expiresAt?: number;
  model?: string;
}

export interface GeminiLiveProviderOptions {
  /** services/token-broker base URL (e.g. http://localhost:8787). */
  brokerUrl: string;
  model?: string;
  apiVersion?: "v1beta" | "v1alpha";
  /** Voice for the character when its pack names none (default `Kore`). */
  defaultVoice?: string;
  /** Reasoning budget before a reply; "off" sends nothing and leaves the model's own default. */
  thinkingLevel?: "minimal" | "standard" | "high" | "off";
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocketLike;
  clock?: () => number;
  /** Gemini extras exposed as capabilities (spec §5); app code must not depend on them. */
  enableAffectiveDialog?: boolean;
  proactiveAudio?: boolean;
  automaticActivityDetection?: AutomaticActivityDetection;
  setupTimeoutMs?: number;
  /** Local VAD used to emit user_speech_* (Gemini sends no user-activity events). */
  localVad?: boolean;
  /**
   * Send audio only while someone is speaking (default). A meeting is mostly silence and paper noise,
   * and streaming all of it to a metered API pays for the silence twice: in tokens, and in the model
   * hearing the room's every cough. The local VAD opens the turn, a short pre-roll keeps the first
   * mora, and `activityEnd` closes it — which is why the setup then disables the server's own VAD.
   * `false` restores the continuous stream (server VAD decides).
   */
  gateAudioOnSpeech?: boolean;
  /**
   * Let the model look things up with Google Search. Without it 「今日のニュースを教えて」 can only be
   * answered honestly by saying it cannot be known — which is what a person asking for the news hears
   * as a broken assistant (2026-09-07, twice). The Live API grounds the answer itself; no tool call
   * comes back to us. Default on for the cloud path.
   */
  googleSearch?: boolean;
  /** Quiet required before the turn closes (ms). Default 250; the VAD's hangover is the first guard. */
  gateHangoverMs?: number;
  /** Max automatic reconnect attempts after goAway / abnormal close (default 4). */
  maxReconnects?: number;
  /** Backoff base in ms (1000 → 1 s, 2 s, 4 s). */
  reconnectBackoffMs?: number;
  /** Test and migration escape hatch; production Gemini 3.1 uses realtimeInput text. */
  forceRealtimeText?: boolean;
  /** Explicit experiment override; defaults bound retained raw audio without disabling memory. */
  contextWindow?: { triggerTokens: number; targetTokens: number };
  /** Baseline comparison only: omit explicit context limits and activity coverage. */
  legacyCostPolicy?: boolean;
}

const OPEN = 1;
const pcmSeconds = (data: string, rate: number) => (data.length * .75 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0)) / (2 * rate);

/**
 * Gemini Live Adapter (spec §5): WSS BidiGenerateContent behind the common RealtimeAIProvider.
 * 16 kHz PCM in / 24 kHz PCM out are absorbed here; the app only sees 48 kHz Float32 frames.
 */
export class GeminiLiveProvider implements RealtimeAIProvider {
  readonly id = "google" as const;
  private listeners = new Set<ConversationEventListener>();
  /** Generation epoch: one generation per model turn; closed on turnComplete / interrupted. */
  private genCounter = new GenerationCounter();
  private costUsage = new LiveUsageAccumulator();
  private inputAudioSeconds = 0;
  private outputAudioSeconds = 0;
  private imageCount = 0;
  private closedConnectionMs = 0;
  private connectionStarts = new Map<WebSocketLike, number>();
  usageSnapshot(): Record<string, number> {
    const liveMs = this.closedConnectionMs + [...this.connectionStarts.values()].reduce((sum, from) => sum + Math.max(0, this.clock() - from), 0);
    return { ...this.costUsage.snapshot(), inputAudioSeconds: this.inputAudioSeconds, outputAudioSeconds: this.outputAudioSeconds, imageCount: this.imageCount, liveActiveSeconds: liveMs / 1000 };
  }
  private genOpen = false;
  /** Observability */
  staleDrops = 0;
  private ws: WebSocketLike | null = null;
  private config: SessionConfig | null = null;
  private outbound: OutboundAudioConverter | null = null;
  private inbound = new AudioNormalizer();
  private vad: EnergyVAD | null;
  private clock: () => number;
  private closing = false;
  private setupDone = false;
  private turn = { audioMs: 0, firstAudioAt: 0, hasAudio: false, id: 0 };
  /** Audio gating: whether a turn is open, and the pre-roll kept for the moment it opens. */
  private speechOpen = false;
  private preroll: string[] = [];
  private static readonly PREROLL_CHUNKS = 15; // 640 B at 16 kHz = 20 ms each → 300 ms
  /**
   * The gate's own fallback, for the room the VAD gives up on. The adaptive VAD tracks the noise floor,
   * and in a room that is never quiet — a television, a fan, a mic with gain — the floor climbs until
   * speech no longer clears it by 12 dB and the gate never opens: the character goes deaf with every
   * meter reading healthy (2026-09-07, one-to-one on Gemini: 2 437 frames forwarded, 0 transcripts).
   *
   * The fallback is *relative* to that same floor, never an absolute level. A fixed -45 dBFS bar was
   * the next failure and a worse one: a meeting stream with automatic gain sits above it even in
   * silence, so the gate opened on the room's own hiss and never closed — the model was sent a turn
   * that never ended, transcribed every word of it and answered none (same day, 48 transcripts, not
   * one reply). Speech clears the learnt floor; the room's own noise, by definition, does not.
   */
  private static readonly GATE_MARGIN_DB = 6;
  private static readonly GATE_ABSOLUTE_FLOOR_DB = -55;
  /**
   * How long the level must stay under the bar before the turn is closed. It is a second guard, not the
   * first: the VAD's own hangover (250 ms) is what decides the person has stopped, and every millisecond
   * here is added to the wait before the model may answer. Overridable for measurement.
   */
  // A 350 ms clause boundary in real speech is not the end of the request.
  // Keep the audio turn open through it so the model retains dates and numbers.
  private static readonly GATE_HANGOVER_MS = 500;
  private loudUntil = 0;
  /**
   * Bound a stuck microphone without cutting ordinary explanations and interview answers short.
   * Eight seconds cut the final request off a nine-second utterance. The normal silence detector
   * still closes promptly; this two-minute ceiling applies only when no end was detected.
   */
  private static readonly MAX_OPEN_MS = 120_000;
  private openedAt = 0;
  /**
   * The first second of a session belongs to the room, not to the character. The VAD's noise floor
   * starts at -60 dBFS and has to hear the room before it knows what quiet is, so until it does, only
   * the VAD may open a turn — the level fallback would open on the room's own hiss and hand the model
   * a second of nothing to answer (P0 gate, 07 Sep: six seconds of silence drew a reply).
   */
  private static readonly WARMUP_MS = 1500;
  private firstFrameAt = 0;
  /**
   * After a forced close, the gate stays shut until the room is quiet again (or the VAD reports a new
   * onset). Without it a loud room reopens on the very next frame and the "turn" resumes for ever.
   */
  private rearm = false;
  /**
   * Half duplex while the character speaks, because the room is a room. Her voice leaves the page,
   * reaches the call, and comes back — through the vendor's mix, or through a laptop speaker into the
   * microphone next to it. Sent on, the model hears itself, answers itself, and the call howls
   * (2026-09-07, one-to-one on Gemini). So input is held while she is speaking, and only real
   * loudness — someone talking over her, well above her own return path — opens the gate again.
   */
  private static readonly BARGE_IN_LEVEL_DB = -28;
  private static readonly SELF_TAIL_MS = 400;
  /**
   * How long a voice must stay over hers before her reply is cut, and the cut is ours: waiting for the
   * model to notice took 4.3 s of her talking over a person who had asked her to stop (P0 gate, 07 Sep).
   * A cough is not an interruption, so it is not the first loud frame either — but 140 ms of somebody
   * talking is, and stopping is local, immediate, and owes nothing to a round trip.
   */
  private static readonly BARGE_IN_CONFIRM_MS = 140;
  private bargeInSince = 0;
  /** Set while the tail of a locally cut reply is still arriving; cleared by the server's own turn end. */
  private droppingUntilTurn = false;
  /** Observability: audio chunks sent to the API and chunks the gate kept out of it. */
  readonly gateStats = { sent: 0, held: 0, opens: 0, closes: 0, forced: 0, openMs: 0, bargeIns: 0 };
  /**
   * What a conversation is judged on, kept apart from what is easy to measure. `turnComplete` arrives
   * when the model has finished *sending* a reply — for a ten-second answer that is ten seconds after
   * the first sound, and reading it as latency would condemn a fast turn. The number that decides
   * whether a meeting feels alive is the first one: the room stops talking, and how long until it
   * hears something. Both are recorded; only the first is latency.
   */
  private timing: { setupCompleteAt: number; userSpeechStartAt: number; userSpeechEndAt: number; source: "speech" | "text" } =
    { setupCompleteAt: 0, userSpeechStartAt: 0, userSpeechEndAt: 0, source: "speech" };
  private userTranscript = "";
  private userTranscriptId = 0;
  private deliveredUserTranscript = "";
  private assistantTranscript = "";
  private endedTimer: ReturnType<typeof setTimeout> | null = null;
  private resumptionHandle: string | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private sessionEpoch = 0;
  private sessionAbort = new AbortController();
  private cancelSetup: (() => void) | null = null;
  private connectedModel = "";
  private pendingContext = "";
  private get realtimeTextOnly(): boolean { return this.opts.forceRealtimeText === true || /gemini-3[.\d]*-flash-live/.test(this.connectedModel) && this.opts.wsFactory === undefined; }
  /** Diagnostics for harnesses. */
  readonly diagnostics = { reconnects: 0, reconnectFailures: 0 };

  constructor(private readonly opts: GeminiLiveProviderOptions) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    // Keep brief intra-sentence pauses together without adding the generic VAD's full 500 ms
    // to every realtime reply. The independent level gate still has to agree before activityEnd.
    this.vad = opts.localVad === false ? null : new EnergyVAD({ hangoverMs: 250 });
    this.searchWanted = opts.googleSearch !== false;
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeAudio: true,
      vision: true,
      toolCalling: true,
      realtimeTranscript: true,
      interruption: true,
      emotionUnderstanding: true,
      localOnly: false,
      extras: {
        bargeIn: true,
        // The model grounds its own answers with Google Search: what it may say about today changes.
        // False once a session has been refused the tool, so the instructions match what it can do.
        search: this.searchWanted && (/native-audio/i.test(this.model) || this.opts.googleSearch === true),
        proactiveAudio: this.opts.proactiveAudio ?? false,
        affectiveDialog: this.opts.enableAffectiveDialog ?? true,
        vision: true,
        liveTranscription: true,
      },
    };
  }

  onEvent(callback: ConversationEventListener): void {
    this.listeners.add(callback);
  }

  /**
   * Whether this session asks for search grounding at all. Cleared for the life of the session when a
   * setup carrying the tool is refused, so the reconnect comes back without it: a character that can
   * talk about everything except today beats one that cannot connect.
   */
  private searchWanted: boolean;

  /** Audio is gated on speech unless the operator asked for the continuous stream. */
  private get gating(): boolean {
    return this.opts.gateAudioOnSpeech !== false && !!this.vad;
  }

  get model(): string {
    return this.opts.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  }

  // ---- lifecycle ------------------------------------------------------------

  async connect(config: SessionConfig): Promise<void> {
    privacyGuard.assert(config.privacyMode, "cloud_conversation");
    // Public connect always starts a new conversation; only reconnect may reuse its handle.
    const disconnected = this.disconnect();
    const epoch = this.sessionEpoch;
    await disconnected;
    if (epoch !== this.sessionEpoch) throw new Error("Gemini Live connection cancelled");
    this.sessionAbort = new AbortController();
    this.config = config;
    this.closing = false;
    this.outbound = new OutboundAudioConverter({ targetRate: GEMINI_INPUT_RATE, chunkMs: 20 });
    this.inbound = new AudioNormalizer();
    this.vad?.reset();
    this.speechOpen = false;
    this.rearm = false;
    this.preroll = [];
    this.reconnectAttempts = 0;
    this.searchWanted = this.opts.googleSearch !== false;
    this.firstFrameAt = 0;
    const token = await this.fetchToken();
    if (this.closing || epoch !== this.sessionEpoch) throw new Error("Gemini Live connection cancelled");
    const model = token.model ?? this.model;
    const wss = this.socketUrl(token);
    try {
      await this.openSocket(wss, model, config);
    } catch (err) {
      // A model that will not take the search tool refuses the whole session. Come back without it.
      const refusedTool = this.searchWanted && /quota|invalid argument|unsupported/i.test(err instanceof Error ? err.message : String(err));
      if (!refusedTool || this.closing || epoch !== this.sessionEpoch) throw err;
      this.searchWanted = false;
      this.emit({ type: "error", error: new Error("Gemini Live refused search grounding; continuing without it"), fatal: false });
      // Tokens are single-use. A refused setup may already have consumed the first one.
      const retryToken = await this.fetchToken();
      if (this.closing || epoch !== this.sessionEpoch) throw new Error("Gemini Live connection cancelled");
      await this.openSocket(this.socketUrl(retryToken), retryToken.model ?? model, config);
    }
    if (this.closing || epoch !== this.sessionEpoch) throw new Error("Gemini Live connection cancelled");
    this.timing.setupCompleteAt = this.clock();
    this.emit({ type: "session_ready", providerId: this.id });
    // Opening line is owned by the provider (see integration contracts): ask for it as a client turn.
    const opening = (config.providerOptions?.opening as string | undefined)?.trim();
    if (opening) await this.sendText(`(セッション開始。最初に次の一言で会話を始めてください: 「${opening}」)`);
  }

  private vertexBackend = false;
  private socketUrl(token: GeminiTokenResponse): string {
    this.vertexBackend = token.backend === "vertex";
    if (!this.vertexBackend) return geminiWssUrl(this.opts.apiVersion ?? "v1beta", token.token);
    const url = new URL(this.opts.brokerUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/live/vertex";
    url.search = "";
    url.searchParams.set("ticket", token.token);
    return url.toString();
  }

  private async fetchToken(): Promise<GeminiTokenResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/token/gemini`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model }),
      signal: AbortSignal.any([this.sessionAbort.signal, AbortSignal.timeout(this.opts.setupTimeoutMs ?? 10_000)]),
    });
    if (!res.ok) {
      let detail = "";
      try {
        const j = (await res.json()) as { error?: string };
        detail = j.error ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(detail || `token broker responded ${res.status}`);
    }
    const json = (await res.json()) as GeminiTokenResponse;
    if (!json.token) throw new Error("token broker returned no token");
    return json;
  }

  private openSocket(url: string, model: string, config: SessionConfig): Promise<void> {
    this.connectedModel = model;
    // Enough to tell an auth problem from a wrong endpoint without ever printing the credential.
    const where = (() => {
      try {
        const u = new URL(url);
        const cred = u.searchParams.get("access_token") ?? u.searchParams.get("key");
        return `${u.pathname.split(".").slice(-3, -1).join(".")} credential=${cred ? "present" : "missing"}`;
      } catch {
        return "unparseable url";
      }
    })();
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    const ws = factory(url);
    this.ws = ws;
    this.setupDone = false;
    const epoch = this.sessionEpoch;
    const ownsSocket = () => !this.closing && epoch === this.sessionEpoch && this.ws === ws;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancel = () => done(new Error("Gemini Live connection cancelled"));
      const timeout = setTimeout(() => done(new Error("Gemini Live setup timed out")), this.opts.setupTimeoutMs ?? 10_000);
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.cancelSetup === cancel) this.cancelSetup = null;
        if (err) {
          if (this.ws === ws) this.ws = null;
          try { ws.close(1000, "setup ended"); } catch { /* already closed */ }
        }
        err ? reject(err) : resolve();
      };
      this.cancelSetup = cancel;
      ws.onopen = () => {
        if (!ownsSocket()) { cancel(); return; }
        this.connectionStarts.set(ws, this.clock());
        ws.send(JSON.stringify({ setup: this.buildSetup(model, config) }));
      };
      ws.onmessage = (ev) => {
        void this.decode(ev.data).then((msg) => {
          if (!msg || !ownsSocket()) return;
          if (msg.setupComplete && !this.setupDone) {
            this.setupDone = true;
            done();
          }
          this.handleServerMessage(msg);
        });
      };
      ws.onerror = () => {
        if (!ownsSocket()) return;
        done(new Error("Gemini Live websocket error"));
        if (this.setupDone) this.emit({ type: "error", error: new Error("Gemini Live websocket error") });
      };
      ws.onclose = (ev) => {
        const from = this.connectionStarts.get(ws);
        if (from !== undefined) { this.closedConnectionMs += Math.max(0, this.clock() - from); this.connectionStarts.delete(ws); }
        done(new Error(`Gemini Live socket closed before setup [${where}] (${ev?.code ?? ""} ${ev?.reason ?? ""})`.trim()));
        if (!ownsSocket()) return;
        this.ws = null;
        if (this.closing || !this.setupDone || this.reconnecting) return;
        if (ev?.code === 1000) {
          this.emit({ type: "session_closed", reason: ev?.reason || "closed" });
          return;
        }
        // Abnormal close (network blip, server restart): reconnect with backoff, resuming the session if possible.
        void this.reconnect(`socket closed (${ev?.code ?? "?"} ${ev?.reason ?? ""})`.trim());
      };
    });
  }

  buildSetup(model: string, config: SessionConfig): GeminiSetup {
    const policy = conversationPolicyFor(config.language);
    const instructions = geminiPromptAdapter.adapt(config.systemPrompt, policy);
    // "native audio" is the `*-native-audio-*` family. The newer `*-flash-live-*` models are not part of
    // it and do not take the same options.
    const nativeAudio = /native-audio/i.test(model);
    const setup: GeminiSetup = {
      model: model.startsWith("models/") ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice || this.opts.defaultVoice || DEFAULT_GEMINI_LIVE_VOICE } },
          // Native-audio models auto-detect language (docs); languageCode is only sent for half-cascade models.
          ...(nativeAudio ? {} : { languageCode: config.language }),
        },
        /**
         * A meeting wants the reply to start, not to be reasoned about: 3.1 Flash Live's own default is
         * "minimal" and this states it, so a model whose default changes does not quietly slow the room
         * down. `thinkingLevel: "off"` sends nothing (for a model that rejects the field).
         */
        ...(this.vertexBackend || this.opts.thinkingLevel === "off" ? {} : { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel ?? "minimal" } }),
        // Affective dialog is a native-audio feature: the newer live models reject the field outright
        // (1007 "Request contains an invalid argument"), which looks like a broken setup rather than an
        // unsupported option.
        ...(nativeAudio && (this.opts.enableAffectiveDialog ?? true) ? { enableAffectiveDialog: true } : {}),
      },
      systemInstruction: { parts: [{ text: instructions }] },
      ...(config.providerOptions?.externalTranscription === true ? {} : { inputAudioTranscription: {} }),
      outputAudioTranscription: {},
      realtimeInputConfig: {
        ...(this.opts.legacyCostPolicy ? {} : { turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY" as const }),
        automaticActivityDetection:
          this.opts.automaticActivityDetection ??
          (this.gating ? { disabled: true } : { disabled: false, silenceDurationMs: 500, prefixPaddingMs: 100 }),
      },
    };
    /**
     * Proactive audio — the model deciding for itself that the right response is none — is the same
     * native-audio-only family as affective dialog. Sent to a `*-flash-live-*` model it is rejected
     * with 1007, which reads as a broken client rather than an unsupported option, so it is gated the
     * same way. The trade-off is real and belongs to whoever picks the model: 3.1 Flash Live is the
     * lower-latency one and has neither feature.
     */
    if (this.opts.proactiveAudio && nativeAudio) setup.proactivity = { proactiveAudio: true };
    const tools: NonNullable<GeminiSetup["tools"]> = [];
    if (config.tools?.length) tools.push({ functionDeclarations: config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) });
    /**
     * Search grounding, where the model will take it. Declared to `gemini-3.1-flash-live-preview` the
     * socket is refused outright — 1011, "You exceeded your current quota" — while the same key grounds
     * happily on the native-audio family and answers with the day's actual news. A tool that closes the
     * session is worse than a question left unanswered, so it is asked for where it is known to work
     * and `googleSearch: true` forces it anywhere else.
     */
    if (this.searchWanted && (!config.tools?.length || this.opts.googleSearch === true) && (nativeAudio || this.opts.googleSearch === true)) tools.push({ googleSearch: {} });
    if (tools.length) setup.tools = tools;
    // Request handles from the first connection, not only after receiving one.
    setup.sessionResumption = this.resumptionHandle ? { handle: this.resumptionHandle } : {};
    const window = this.opts.contextWindow ?? { triggerTokens: 10000, targetTokens: 3000 };
    if (!Number.isSafeInteger(window.triggerTokens) || !Number.isSafeInteger(window.targetTokens) || window.triggerTokens < 5000 || window.triggerTokens > 128000 || window.targetTokens < 0 || window.targetTokens >= window.triggerTokens) {
      throw new Error("Invalid Gemini context window limits");
    }
    setup.contextWindowCompression = this.opts.legacyCostPolicy ? { slidingWindow: {} } : {
      triggerTokens: String(window.triggerTokens), slidingWindow: { targetTokens: String(window.targetTokens) },
    };
    return setup;
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.sessionEpoch++;
    this.sessionAbort.abort();
    this.cancelSetup?.();
    this.onInterrupted(this.clock());
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState < 2) {
      try {
        ws.close(1000, "client disconnect");
      } catch {
        /* ignore */
      }
    }
    this.setupDone = false;
    this.config = null;
    this.pendingContext = "";
    this.resumptionHandle = null;
    this.resetUserTranscript();
    this.outbound = null;
    this.inbound.reset();
    this.vad?.reset();
    this.preroll = [];
    this.speechOpen = false;
    this.rearm = false;
    this.droppingUntilTurn = false;
    this.bargeInSince = 0;
    this.loudUntil = 0;
    this.openedAt = 0;
    this.genCounter.nextTurn();
    this.timing = { setupCompleteAt: 0, userSpeechStartAt: 0, userSpeechEndAt: 0, source: "speech" };
    this.reconnecting = false;
  }

  // ---- input ------------------------------------------------------------------

  pushAudio(frame: PCMFrame): void {
    if (!this.outbound || !this.ws || this.ws.readyState !== OPEN || !this.setupDone) return;
    let opened = false;
    let closed = false;
    if (this.vad) {
      for (const ev of this.vad.process(frame)) {
        if (ev.type === "speech_start") {
          if (!this.gating) this.resetUserTranscript();
          this.genCounter.nextTurn();
          this.timing.userSpeechStartAt = ev.timestamp ?? this.clock();
          this.timing.source = "speech";
          opened = true;
          this.emit({ type: "user_speech_started", at: ev.timestamp });
        }
        else {
          this.timing.userSpeechEndAt = ev.timestamp ?? this.clock();
          closed = true;
          this.emit({ type: "user_speech_ended", at: ev.timestamp });
        }
      }
    }
    const level = dbfs(rms(frame.data));
    // Media time, not wall time: the gate has to hold for a stretch of *audio*, and a burst of frames
    // delivered together must not look like a room that has been loud for a second.
    const now = frame.timestamp ?? this.clock();
    // Above the room's own floor by a margin the room's noise cannot reach on its own.
    const bar = Math.max(GeminiLiveProvider.GATE_ABSOLUTE_FLOOR_DB, (this.vad?.noiseFloor ?? -60) + GeminiLiveProvider.GATE_MARGIN_DB);
    if (level > bar) this.loudUntil = now + (this.opts.gateHangoverMs ?? GeminiLiveProvider.GATE_HANGOVER_MS);
    const loud = now < this.loudUntil;
    // A gate armed shut after a forced close opens again only once the room has actually gone quiet.
    if (this.rearm && !loud) this.rearm = false;
    // While the character is speaking (and for a beat after), only a voice over her own gets through.
    const selfSpeaking = this.turn.hasAudio && this.clock() - (this.turn.firstAudioAt + this.turn.audioMs) < GeminiLiveProvider.SELF_TAIL_MS;
    if (selfSpeaking && !this.speechOpen && level < GeminiLiveProvider.BARGE_IN_LEVEL_DB) {
      this.bargeInSince = 0;
      this.gateStats.held++;
      // Do not transmit the quiet return path while speaking. Keep only its bounded prefix:
      // a person's soft first mora can precede the louder syllable that opens the barge-in gate.
      // Clearing this on every held frame irreversibly dropped that onset (including the name).
      for (const chunk of this.outbound.push(frame)) this.rememberPreroll(bytesToBase64(int16ToBytes(chunk)));
      return;
    }
    /**
     * Somebody is talking over her. Her own reply stops here, not when the model gets round to it: the
     * person who said 「ちょっと待って」 has already waited long enough by the time a round trip lands.
     */
    // An open input turn may contain quiet syllables while assistant audio arrives.
    // Keeping that input must not count silence as sustained barge-in speech.
    if (selfSpeaking && level >= GeminiLiveProvider.BARGE_IN_LEVEL_DB) {
      if (!this.bargeInSince) this.bargeInSince = now;
      if (now - this.bargeInSince >= GeminiLiveProvider.BARGE_IN_CONFIRM_MS) {
        this.bargeInSince = 0;
        this.gateStats.bargeIns++;
        void this.interrupt();
      }
    } else this.bargeInSince = 0;
    if (!this.firstFrameAt) this.firstFrameAt = now;
    const warming = now - this.firstFrameAt < GeminiLiveProvider.WARMUP_MS;
    if (this.gating && (opened || (loud && !this.rearm && !warming)) && !this.speechOpen) {
      this.resetUserTranscript();
      this.speechOpen = true;
      this.openedAt = now;
      this.gateStats.opens++;
      if (opened) this.rearm = false;
      this.send({ realtimeInput: { activityStart: {} } });
      for (const b64 of this.preroll.splice(0)) this.sendAudioChunk(b64);
    }
    for (const chunk of this.outbound.push(frame)) {
      const b64 = bytesToBase64(int16ToBytes(chunk));
      if (!this.gating || this.speechOpen) { this.gateStats.sent++; this.sendAudioChunk(b64); continue; }
      this.gateStats.held++;
      // Silence: keep the last 300 ms so the first mora survives the moment the turn opens.
      this.rememberPreroll(b64);
    }
    // The turn closes when both signals agree the room has stopped: the VAD is out of speech and the
    // level has been under the gate for its hangover. Closing on the VAD event alone left the gate
    // open for ever whenever the fallback was still holding it at that moment.
    if (this.gating && this.speechOpen && !loud && !(this.vad?.isSpeaking ?? false)) {
      this.closeTurn(now);
    } else if (this.gating && this.speechOpen && now - this.openedAt >= GeminiLiveProvider.MAX_OPEN_MS) {
      // The meters never agreed. The model still needs to be told the turn ended.
      this.gateStats.forced++;
      this.rearm = true;
      this.closeTurn(now);
    }
    void closed;
  }

  /** End the open activity window: the model's cue that the user's turn is over and it may answer. */
  private closeTurn(now: number): void {
    this.speechOpen = false;
    // Whatever the model says next answers this turn, so it is not the tail of the cut one.
    this.droppingUntilTurn = false;
    this.gateStats.closes++;
    this.gateStats.openMs += Math.max(0, Math.round(now - this.openedAt));
    // Context is delivered only as part of the next user turn, never as an unsolicited turn.
    if (this.realtimeTextOnly && this.pendingContext) {
      this.send({ realtimeInput: { text: this.pendingContext } });
      this.pendingContext = "";
    }
    this.send({ realtimeInput: { activityEnd: {} } });
    /**
     * What the person just said, delivered now rather than after the answer to it.
     *
     * The final transcript used to wait for `turnComplete` — the end of the *model's* reply — so
     * anything downstream that decides whether a reply may be spoken had nothing to decide on when it
     * began. In a one-to-one on Gemini that was every reply: 14 answers begun, 8 cut, 4 transcripts
     * (2026-09-07 20:5x). We closed the user's turn ourselves; the words in it are complete.
     */
    this.flushUserTranscript();
  }

  private rememberPreroll(data: string): void {
    this.preroll.push(data);
    if (this.preroll.length > GeminiLiveProvider.PREROLL_CHUNKS) this.preroll.shift();
  }

  private sendAudioChunk(data: string): void {
    this.send({ realtimeInput: { audio: { data, mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } });
  }

  pushImage(image: ImageFrame): void {
    if (!this.ws || this.ws.readyState !== OPEN || !this.setupDone) return;
    const data = typeof image.data === "string" ? image.data.replace(/^data:[^,]+,/, "") : bytesToBase64(image.data);
    this.send({ realtimeInput: { video: { data, mimeType: image.mimeType } } });
  }

  async sendText(text: string): Promise<void> {
    // A typed turn has no speech to end; the clock starts when it goes out.
    this.timing.source = "text";
    this.timing.userSpeechStartAt = this.timing.userSpeechEndAt = this.clock();
    this.droppingUntilTurn = false;
    if (this.realtimeTextOnly) {
      // 3.1 accepts clientContent only for initial history; it does not start a conversational turn.
      // https://ai.google.dev/gemini-api/docs/live-api/capabilities#incremental-content-updates
      const content = this.pendingContext ? `${this.pendingContext}\n\n${text}` : text;
      this.pendingContext = "";
      this.send({ realtimeInput: { text: content } });
    } else {
      this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
    }
  }

  /**
   * Explicit interruption. Gemini has no dedicated cancel message; per the API reference a
   * clientContent message "will interrupt any current model generation". We send an empty,
   * non-turn-completing clientContent and drop local playback state immediately.
   */
  async interrupt(): Promise<void> {
    if (this.realtimeTextOnly) {
      if (this.opts.automaticActivityDetection?.disabled ?? this.gating) {
        if (!this.speechOpen) this.send({ realtimeInput: { activityStart: {} } });
        this.send({ realtimeInput: { activityEnd: {} } });
        this.speechOpen = false;
      }
      // Keep the generation cancellation message as the final frame. Gemini 3.1 treats this
      // clientContent form as an interrupt control message even though conversational text uses
      // realtimeInput.text (clientContent text is reserved for initial history).
      this.send({ clientContent: { turnComplete: false } });
    } else this.send({ clientContent: { turnComplete: false } });
    /**
     * The reply we just cut keeps arriving for a moment: the server is mid-generation and does not
     * hear about it until our message lands. Ten frames of a cut answer reached the host on the P0
     * gate (07 Sep). They belong to a turn nobody is listening to any more, so they stop here rather
     * than at every host that has to know to drop them.
     */
    this.droppingUntilTurn = true;
    this.onInterrupted(this.clock());
  }

  /**
   * systemInstruction cannot be changed after setup; the new context is appended to the
   * conversation history as a user-role note without triggering generation.
   */
  async updateContext(context: ConversationContext): Promise<void> {
    if (this.config) this.config = { ...this.config, systemPrompt: context.systemPrompt };
    const ja = context.language.toLowerCase().startsWith("ja");
    const note = ja ? `（システム更新: 以降は次の指示に従うこと）\n${context.systemPrompt}` : `(System update: follow these instructions from now on)\n${context.systemPrompt}`;
    if (this.realtimeTextOnly) { this.pendingContext = note; return; }
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: note }] }], turnComplete: false } });
  }

  /** Reply to a `tool_call` event. */
  sendToolResponse(responses: { id?: string; name: string; response: Record<string, unknown> }[]): void {
    this.send({ toolResponse: { functionResponses: responses } });
  }

  // ---- server messages -------------------------------------------------------

  private handleServerMessage(msg: GeminiServerMessage): void {
    const now = this.clock();
    if (msg.error) {
      this.emit({ type: "error", error: new Error(msg.error.message ?? "Gemini Live error") });
    }
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumptionHandle = msg.sessionResumptionUpdate.newHandle;
    }
    if (msg.toolCall?.functionCalls) {
      // A reply can begin with a function call before any modelTurn/audio arrives. Without a
      // new generation, the runtime discards that call as part of the interrupted reply.
      // Keep late calls inside the cancelled tail stamped with their old generation.
      if (!this.droppingUntilTurn) this.openGeneration();
      for (const fc of msg.toolCall.functionCalls) {
        this.emit({ type: "tool_call", call: { id: fc.id ?? fc.name, name: fc.name, arguments: fc.args ?? {} }, gen: this.genCounter.stamp() });
      }
    }
    if (msg.goAway) {
      this.emit({ type: "error", error: new Error(`Gemini Live goAway (timeLeft ${msg.goAway.timeLeft ?? "?"})`), fatal: false });
      void this.reconnect();
    }
    if (msg.usageMetadata) {
      this.costUsage.observe(msg.usageMetadata);
      const counters = geminiUsageCounters(msg.usageMetadata);
      if (Object.keys(counters).length) this.emit({ type: "usage", provider: "google", model: this.connectedModel ?? this.model, at: now, counters });
    }
    const sc = msg.serverContent;
    for (const part of sc?.modelTurn?.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith("audio/pcm")) this.outputAudioSeconds += pcmSeconds(part.inlineData.data, parsePcmRate(part.inlineData.mimeType));
    }
    if (sc?.turnComplete || sc?.interrupted) {
      const model = this.connectedModel ?? this.model;
      if (this.costUsage.complete(model)) this.emit({ type: "usage", provider: "google", model, at: now, counters: this.usageSnapshot() });
    }
    if (!sc) return;

    if (sc.interrupted) {
      // The server's acknowledgement, not the end of the tail: audio for the cut reply arrives after
      // it. What ends the drop is a turn ending — the model's (`turnComplete`) or the room's next one.
      this.onInterrupted(now);
    }
    if (sc.inputTranscription?.text) {
      this.userTranscript += sc.inputTranscription.text;
      this.emit({ type: "user_transcript", id: this.userTranscriptId, text: this.userTranscript, final: false });
      if (this.deliveredUserTranscript) this.flushUserTranscript();
    }
    if (sc.modelTurn?.parts?.length && this.droppingUntilTurn) return; // the tail of a cut reply
    if (sc.modelTurn?.parts?.length) {
      this.flushUserTranscript();
      this.openGeneration();
      for (const part of sc.modelTurn.parts) {
        if (part.inlineData?.mimeType?.startsWith("audio/pcm")) {
          this.handleAudioPart(part.inlineData.data, parsePcmRate(part.inlineData.mimeType), now);
        } else if (part.thought) {
          // The model's own reasoning, not speech. It reached the caption line as
          // 「**Analyzing Anxious Communication**」 in front of the actual reply.
          continue;
        } else if (part.text) {
          this.assistantTranscript += part.text;
          this.emit({ type: "assistant_transcript", text: part.text, final: false, gen: this.genCounter.stamp() });
        }
      }
    }
    if (sc.outputTranscription?.text) {
      this.openGeneration();
      this.assistantTranscript += sc.outputTranscription.text;
      this.emit({ type: "assistant_transcript", text: sc.outputTranscription.text, final: false, gen: this.genCounter.stamp() });
    }
    if (sc.turnComplete) {
      this.droppingUntilTurn = false;
      this.flushUserTranscript();
      if (this.assistantTranscript) {
        this.emit({ type: "assistant_transcript", text: this.assistantTranscript, final: true, gen: this.genCounter.stamp() });
      }
      const from = this.timing.userSpeechEndAt;
      if (from) {
        this.emit({
          type: "metrics",
          gen: this.genCounter.stamp(),
          turn: {
            source: this.timing.source,
            // speech end → the first sound of the reply: the conversation's latency.
            ...(this.turn.hasAudio ? { firstAudioSentMs: this.turn.firstAudioAt - from } : {}),
            // speech end → the model finished sending. The reply's own length lives in here; not latency.
            totalMs: now - from,
            engines: { llm: this.connectedModel || this.model },
          },
        });
      }
      this.resetUserTranscript();
      this.scheduleSpeechEnded(now);
      this.genOpen = false; // the next modelTurn is a new generation
    }
  }

  /** A model turn that starts after turnComplete/interrupted is a new generation. */
  private openGeneration(): void {
    if (this.genOpen) return;
    this.genCounter.nextGeneration();
    this.genOpen = true;
  }

  private handleAudioPart(b64: string, rate: number, now: number): void {
    const pcm = int16ToFloat32(bytesToInt16(base64ToBytes(b64)));
    if (pcm.length === 0) return;
    if (!this.turn.hasAudio) {
      this.turn.hasAudio = true;
      this.turn.firstAudioAt = now;
      this.turn.audioMs = 0;
      this.inbound.reset();
      this.emit({ type: "assistant_speech_started", at: now, gen: this.genCounter.stamp() });
    }
    this.turn.audioMs += (pcm.length / rate) * 1000;
    const frame = this.inbound.push({ data: pcm, sampleRate: rate, channels: 1, timestamp: now });
    this.emit({ type: "assistant_audio", frame, gen: this.genCounter.stamp() });
  }

  /** turnComplete arrives before playback finishes: delay `assistant_speech_ended` by the remaining audio. */
  private scheduleSpeechEnded(now: number): void {
    this.clearEndedTimer();
    const turnId = this.turn.id;
    const gen = this.genCounter.stamp();
    const finish = () => {
      this.endedTimer = null;
      if (this.turn.id !== turnId) return; // interrupted / new turn
      this.emit({ type: "assistant_speech_ended", at: this.clock(), gen });
      this.resetTurn();
    };
    if (!this.turn.hasAudio) {
      this.resetTurn();
      return;
    }
    const remaining = Math.max(0, this.turn.audioMs - (now - this.turn.firstAudioAt));
    this.endedTimer = setTimeout(finish, remaining);
  }

  private onInterrupted(at: number): void {
    this.clearEndedTimer();
    const wasSpeaking = this.turn.hasAudio;
    const cancelled = this.genCounter.current();
    this.resetTurn();
    this.genOpen = false; // anything else from this generation is stale; the next modelTurn opens a new one
    if (wasSpeaking) this.emit({ type: "interrupted", at, gen: cancelled });
  }

  private flushUserTranscript(): void {
    if (!this.userTranscript.trim() || this.userTranscript === this.deliveredUserTranscript) return;
    // Transcription may trail our activityEnd and arrive alongside model audio. Keep the
    // original utterance ID and append late words instead of inventing a second question.
    if (this.deliveredUserTranscript) {
      this.emit({ type: "user_transcript_revised", id: this.userTranscriptId, text: this.userTranscript });
    } else {
      this.emit({ type: "user_transcript", id: this.userTranscriptId, text: this.userTranscript, final: true });
    }
    this.deliveredUserTranscript = this.userTranscript;
  }

  private resetUserTranscript(): void {
    this.userTranscript = "";
    this.deliveredUserTranscript = "";
    this.userTranscriptId++;
  }

  private resetTurn(): void {
    this.turn = { audioMs: 0, firstAudioAt: 0, hasAudio: false, id: this.turn.id + 1 };
    this.assistantTranscript = "";
  }

  private clearEndedTimer(): void {
    if (this.endedTimer) clearTimeout(this.endedTimer);
    this.endedTimer = null;
  }

  private async reconnect(reason = "goAway"): Promise<void> {
    if (!this.config || this.closing || this.reconnecting) return;
    this.reconnecting = true;
    const epoch = this.sessionEpoch;
    const config = this.config;
    const old = this.ws;
    this.ws = null;
    this.setupDone = false;
    try { if (old && old.readyState < 2) old.close(1000, "reconnect"); } catch { /* already closed */ }
    this.speechOpen = false;
    this.preroll = [];
    this.rearm = false;
    this.droppingUntilTurn = false;
    this.bargeInSince = 0;
    this.resetUserTranscript();
    this.outbound = new OutboundAudioConverter({ targetRate: GEMINI_INPUT_RATE, chunkMs: 20 });
    this.vad?.reset();
    this.clearEndedTimer();
    if (this.turn.hasAudio) this.onInterrupted(this.clock());
    this.emit({ type: "error", error: new Error(`Gemini Live: ${reason}; reconnecting`), fatal: false });
    // 1 + 2 + 4 seconds exhausts three attempts before a 10-second outage ends.
    // The fourth attempt at 15 seconds permits recovery while retaining a finite retry budget.
    const max = this.opts.maxReconnects ?? 4;
    const base = this.opts.reconnectBackoffMs ?? 1000;
    try {
      while (this.reconnectAttempts < max && !this.closing && epoch === this.sessionEpoch) {
        const attempt = ++this.reconnectAttempts;
        // goAway gives us a live socket for a while: try immediately, then back off.
        if (!(reason === "goAway" && attempt === 1)) await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
        if (this.closing || epoch !== this.sessionEpoch) return;
        try {
          const token = await this.fetchToken();
          if (this.closing || epoch !== this.sessionEpoch) return;
          await this.openSocket(this.socketUrl(token), token.model ?? this.model, config);
          if (this.closing || epoch !== this.sessionEpoch) return;
          try {
            if (old && old !== this.ws && old.readyState === OPEN) old.close(1000, "reconnect");
          } catch {
            /* ignore */
          }
          this.diagnostics.reconnects++;
          this.reconnectAttempts = 0;
          this.emit({ type: "session_ready", providerId: this.id });
          return;
        } catch (err) {
          if (this.closing || epoch !== this.sessionEpoch) return;
          this.diagnostics.reconnectFailures++;
          this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)), fatal: false });
        }
      }
      if (!this.closing && epoch === this.sessionEpoch) {
        this.emit({ type: "error", error: new Error(`Gemini Live: reconnect failed after ${max} attempts`), fatal: true });
        this.emit({ type: "session_closed", reason: "reconnect exhausted" });
      }
    } finally {
      if (epoch === this.sessionEpoch) this.reconnecting = false;
    }
  }

  // ---- plumbing -------------------------------------------------------------------

  private send(msg: GeminiClientMessage): void {
    if (this.closing || !this.ws || this.ws.readyState !== OPEN || !this.setupDone) return;
    this.ws.send(JSON.stringify(msg));
    if ("realtimeInput" in msg) {
      if (msg.realtimeInput.audio) this.inputAudioSeconds += pcmSeconds(msg.realtimeInput.audio.data, parsePcmRate(msg.realtimeInput.audio.mimeType));
      if (msg.realtimeInput.video) this.imageCount++;
    }
  }

  private async decode(data: unknown): Promise<GeminiServerMessage | null> {
    try {
      let text: string;
      if (typeof data === "string") text = data;
      else if (typeof Blob !== "undefined" && data instanceof Blob) text = await data.text();
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
      else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as Uint8Array);
      else return null;
      return JSON.parse(text) as GeminiServerMessage;
    } catch {
      return null;
    }
  }

  private emit(e: ConversationEvent): void {
    for (const l of this.listeners) l(e);
  }
}
