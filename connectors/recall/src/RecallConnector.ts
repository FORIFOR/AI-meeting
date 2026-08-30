import { AudioNormalizer, base64Pcm16ToFloat32, concatFloat32, createFrame, createResampler, float32ToInt16, type PCMFrame } from "@rcai/audio-core";
import { PrivacyViolationError } from "@rcai/provider-core";
import {
  MeetingLifecycle,
  detectPlatform,
  lifecycleToStatus,
  mapRecallStatus,
  type JoinRequest,
  type LifecycleOptions,
  type LifecycleSnapshot,
  type LifecycleTransition,
  type MeetingConnector,
  type MeetingConnectorCapabilities,
  type MeetingEvent,
  type MeetingEventListener,
  type MeetingPlatform,
  type MeetingSession,
  type MeetingStatus,
} from "@rcai/meeting-core";
import { wordsToText, type BotStatusResponse, type CreateBotResponse, type RecallMode, type RelayedMessage } from "./protocol.js";

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Encodes a mono Int16 PCM clip to MP3 bytes (Recall Output Audio accepts only mp3). Supplied by the app. */
export type Mp3Encoder = (pcm16: Int16Array, sampleRate: number) => Promise<Uint8Array>;

export interface RecallConnectorOptions {
  brokerUrl: string;
  /**
   * output_media (default): the bot streams our own web page (bot mode) — audio/video out are native, lowest latency.
   * relay: realtime events are relayed through the broker to this browser; audio out uses MP3 clips (needs `mp3Encoder`).
   */
  mode?: RecallMode;
  /** Extra query parameters for the bot page (character, persona, engine…). */
  botPageQuery?: Record<string, string>;
  mp3Encoder?: Mp3Encoder;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => WebSocketLike;
  pollIntervalMs?: number;
  clock?: () => number;
  /** Lifecycle tuning (reconnect backoff/timeout, output-media retries). */
  lifecycle?: LifecycleOptions;
  /** output_media: fail (and retry once) when the bot page has not activated this long after admission (ms). Default 20 000. */
  outputMediaActivationTimeoutMs?: number;
  /** Timer injection for tests. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}

export class RecallConnector implements MeetingConnector {
  readonly id = "recall" as const;

  constructor(private readonly opts: RecallConnectorOptions) {}

  capabilities(): MeetingConnectorCapabilities {
    const mode = this.opts.mode ?? "output_media";
    return {
      platforms: ["google_meet", "zoom", "teams", "webex"],
      audioOut: mode === "output_media" ? "pcm_stream" : this.opts.mp3Encoder ? "clip" : "none",
      separateParticipantAudio: false,
      realtimeTranscript: true,
      videoOut: mode === "output_media",
    };
  }

  async join(req: JoinRequest): Promise<MeetingSession> {
    if (req.privacyMode === "strict_local") throw new PrivacyViolationError("cloud_conversation");
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const mode = this.opts.mode ?? "output_media";
    const res = await fetchImpl(`${this.base}/api/meeting/recall/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meetingUrl: req.meetingUrl, botName: req.displayName, mode, language: req.language, botPageQuery: this.opts.botPageQuery }),
    });
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "BLOCKED_BY_RECALL_KEY");
    }
    if (!res.ok) throw new Error(`recall create bot failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const created = (await res.json()) as CreateBotResponse;
    const session = new RecallSession(created, detectPlatform(req.meetingUrl), this.opts, fetchImpl);
    session.start();
    return session;
  }

  private get base(): string {
    return this.opts.brokerUrl.replace(/\/$/, "");
  }
}

export class RecallSession implements MeetingSession {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly lifecycle: MeetingLifecycle;
  private listeners = new Set<MeetingEventListener>();
  private ws: WebSocketLike | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private inbound = new AudioNormalizer();
  private outboundResampler = createResampler(48_000, 24_000);
  private outbound: Float32Array[] = [];
  private clock: () => number;
  private lastCode = "";
  private lastSub: string | null | undefined;
  private admittedAt: number | null = null;
  private activatedAt: number | null = null;
  private outputMediaRestartInFlight = false;
  private wsWasOpen = false;
  private readonly timers: NonNullable<RecallConnectorOptions["timers"]>;

  constructor(readonly created: CreateBotResponse, readonly platform: MeetingPlatform, private readonly opts: RecallConnectorOptions, private readonly fetchImpl: typeof fetch) {
    this.id = created.botId;
    this.sessionId = created.sessionId;
    this.clock = opts.clock ?? (() => Date.now());
    this.timers = opts.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    this.lifecycle = new MeetingLifecycle(this.clock(), opts.lifecycle);
    this.lifecycle.onTransition((t) => this.onLifecycle(t));
    this.lifecycle.onMute((muted, at) => this.emit({ type: "audio_muted", muted, at }));
    const initial = mapRecallStatus(created.status);
    if (initial) this.lifecycle.dispatch({ type: "vendor_status", state: initial.state, detail: initial.detail }, this.clock());
  }

  status(): MeetingStatus {
    return lifecycleToStatus(this.lifecycle.state);
  }

  snapshot(): LifecycleSnapshot {
    return this.lifecycle.snapshot();
  }

  /** True while the character's voice may go out (admitted, not muted, not reconnecting). */
  get outboundAllowed(): boolean {
    return this.lifecycle.outboundAllowed;
  }

  onEvent(cb: MeetingEventListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Opens the relay socket and starts status polling + lifecycle ticks. */
  start(): void {
    this.openSocket();
    const every = this.opts.pollIntervalMs ?? 3000;
    this.pollTimer = this.timers.setInterval(() => void this.poll(), every);
    this.tickTimer = this.timers.setInterval(() => this.tick(), 1000);
    void this.poll();
  }

  /** Host muted / unmuted the character (from the bot page or an operator). */
  setAudioMuted(muted: boolean): void {
    this.lifecycle.dispatch({ type: "host_mute", muted }, this.clock());
  }

  /** Bot page reported it is up (output_media activation seen by the broker or the page itself). */
  markOutputMediaActive(at: number = this.clock()): void {
    this.activatedAt = at;
    this.lifecycle.dispatch({ type: "output_media_ok" }, at);
  }

  private onLifecycle(t: LifecycleTransition): void {
    const at = t.at;
    const status = lifecycleToStatus(t.to);
    this.emit({ type: "status", status, detail: t.reason, at });
    if (t.to === "admitted" && t.from !== "reconnecting") {
      this.admittedAt = at;
      this.emit({ type: "joined", at });
    }
    if (t.to === "reconnecting") this.scheduleReconnect();
    if (this.lifecycle.isTerminal) {
      this.emit({ type: "left", reason: t.reason, at });
      this.cleanup();
    }
  }

  private openSocket(): void {
    if (this.closed || this.lifecycle.isTerminal) return;
    const factory = this.opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    let ws: WebSocketLike;
    try {
      ws = factory(this.created.clientWsUrl);
    } catch (e) {
      this.emit({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
      this.lifecycle.dispatch({ type: "relay_down" }, this.clock());
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.wsWasOpen = true;
      this.lifecycle.dispatch({ type: "relay_up" }, this.clock());
    };
    ws.onmessage = (ev) => this.onRelayMessage(ev.data);
    ws.onclose = () => {
      if (this.closed || this.lifecycle.isTerminal) return;
      this.ws = null;
      const t = this.lifecycle.dispatch({ type: "relay_down" }, this.clock());
      // Before admission the relay may legitimately not exist yet: retry quietly.
      if (!t && this.lifecycle.state !== "reconnecting") this.reconnectTimer = this.timers.setTimeout(() => this.openSocket(), 2000);
    };
    ws.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    const delay = this.lifecycle.nextReconnectDelayMs(this.clock());
    if (delay === null) {
      this.lifecycle.dispatch({ type: "tick" }, this.clock() + 1e9); // force reconnect_timeout → failed
      return;
    }
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.lifecycle.state !== "reconnecting") return;
      this.openSocket();
      // If the socket does not come up, onclose → relay_down (ignored while reconnecting) → schedule again.
      this.reconnectTimer = this.timers.setTimeout(() => {
        if (this.lifecycle.state === "reconnecting") this.scheduleReconnect();
      }, 1500);
    }, delay);
  }

  /** 1 s lifecycle tick: reconnect timeout + output-media activation watchdog. */
  tick(now: number = this.clock()): void {
    if (this.closed) return;
    this.lifecycle.dispatch({ type: "tick" }, now);
    const timeout = this.opts.outputMediaActivationTimeoutMs ?? 20_000;
    if ((this.opts.mode ?? "output_media") === "output_media" && this.lifecycle.state === "admitted" && this.admittedAt !== null && this.activatedAt === null && !this.outputMediaRestartInFlight && now - this.admittedAt >= timeout) {
      this.admittedAt = now; // re-arm the watchdog for the retry window
      const t = this.lifecycle.dispatch({ type: "output_media_failed", detail: "bot page not activated" }, now);
      if (!t) void this.restartOutputMedia();
    }
  }

  private async restartOutputMedia(): Promise<void> {
    this.outputMediaRestartInFlight = true;
    try {
      const res = await this.fetchImpl(`${this.base}/api/meeting/recall/bots/${encodeURIComponent(this.id)}/output_media/restart`, { method: "POST" });
      if (!res.ok) this.lifecycle.dispatch({ type: "output_media_failed", detail: `restart ${res.status}` }, this.clock());
    } catch (e) {
      this.emit({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
    } finally {
      this.outputMediaRestartInFlight = false;
    }
  }

  /** Handles one relayed Recall realtime message (public for tests). */
  onRelayMessage(raw: unknown): void {
    let parsed: RelayedMessage | null = null;
    try {
      parsed = typeof raw === "string" ? (JSON.parse(raw) as RelayedMessage) : null;
    } catch {
      return;
    }
    if (!parsed?.message) return;
    if (parsed.relay?.botId && parsed.relay.botId !== this.id) return; // bot binding: ignore foreign frames
    const msg = parsed.message;
    const d = msg.data?.data ?? null;
    const at = this.clock();
    switch (msg.event) {
      case "audio_mixed_raw.data": {
        if (!d?.buffer) return;
        const f32 = base64Pcm16ToFloat32(d.buffer);
        const frame = this.inbound.push({ data: f32, sampleRate: 16_000, channels: 1, timestamp: at });
        this.emit({ type: "audio", frame });
        return;
      }
      case "transcript.data":
      case "transcript.partial_data": {
        const text = wordsToText(d?.words);
        if (!text) return;
        this.emit({ type: "transcript", text, final: msg.event === "transcript.data", participantId: d?.participant ? String(d.participant.id) : undefined, speakerName: d?.participant?.name ?? null, at });
        return;
      }
      case "participant_events.join":
      case "participant_events.leave": {
        if (!d?.participant) return;
        const participant = { id: String(d.participant.id), name: d.participant.name, isHost: d.participant.is_host ?? undefined };
        this.emit({ type: msg.event === "participant_events.join" ? "participant_joined" : "participant_left", participant, at });
        return;
      }
      case "participant_events.update": {
        // Best effort: Recall does not document a mute event; some platforms surface it in the update payload.
        const p = (d?.participant ?? null) as ({ is_self?: boolean; id: number } | null);
        const raw = (d as unknown as Record<string, unknown> | null) ?? {};
        const muted = raw.muted ?? raw.audio_muted ?? raw.is_muted;
        if (p?.is_self === true && typeof muted === "boolean") this.setAudioMuted(muted);
        return;
      }
      case "participant_events.speech_on":
      case "participant_events.speech_off": {
        if (!d?.participant) return;
        this.emit({ type: "speech", participant: { id: String(d.participant.id), name: d.participant.name }, active: msg.event.endsWith("speech_on"), at });
        return;
      }
      default:
        return;
    }
  }

  async poll(): Promise<void> {
    if (this.closed) return;
    try {
      const res = await this.fetchImpl(`${this.base}/api/meeting/recall/bots/${encodeURIComponent(this.id)}`);
      if (!res.ok) return;
      const body = (await res.json()) as BotStatusResponse;
      if (typeof body.botPageActivatedAt === "number" && this.activatedAt === null) this.markOutputMediaActive(body.botPageActivatedAt);
      this.applyStatus(body.code, body.subCode ?? undefined);
    } catch {
      /* transient */
    }
  }

  /** Applies a Recall status code + sub_code (public for tests / fixtures). */
  applyStatus(code: string, subCode?: string | null): void {
    if (code === this.lastCode && (subCode ?? null) === (this.lastSub ?? null)) return;
    this.lastCode = code;
    this.lastSub = subCode;
    const m = mapRecallStatus(code, subCode);
    if (!m) return;
    this.lifecycle.dispatch({ type: "vendor_status", state: m.state, detail: m.detail }, this.clock());
  }

  pushOutboundAudio(frame: PCMFrame): void {
    if (!this.lifecycle.outboundAllowed) return; // waiting room / muted / reconnecting / terminal: drop
    if ((this.opts.mode ?? "output_media") === "output_media") return; // the bot page plays audio natively
    this.outbound.push(this.outboundResampler.process(frame.sampleRate === 48_000 ? frame.data : createResampler(frame.sampleRate, 48_000).process(frame.data)));
  }

  /** relay mode: flush the buffered utterance as one MP3 clip via the broker → Recall Output Audio. */
  async endOutboundUtterance(): Promise<void> {
    if ((this.opts.mode ?? "output_media") === "output_media" || this.outbound.length === 0) return;
    const pcm = concatFloat32(this.outbound);
    this.outbound = [];
    if (!this.lifecycle.outboundAllowed) return;
    if (!this.opts.mp3Encoder) {
      this.emit({ type: "error", error: new Error("BLOCKED_BY_MP3_ENCODER: Recall Output Audio accepts mp3 only; supply RecallConnectorOptions.mp3Encoder or use output_media mode") });
      return;
    }
    const mp3 = await this.opts.mp3Encoder(float32ToInt16(pcm), 24_000);
    const b64 = typeof Buffer !== "undefined" ? Buffer.from(mp3).toString("base64") : btoa(String.fromCharCode(...mp3));
    await this.fetchImpl(`${this.base}/api/meeting/recall/bots/${encodeURIComponent(this.id)}/output_audio`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "mp3", b64_data: b64 }),
    });
  }

  async leave(): Promise<void> {
    if (this.closed) return;
    const wasTerminal = this.lifecycle.isTerminal;
    this.lifecycle.dispatch({ type: "leave" }, this.clock()); // → left + cleanup + "left" event
    if (wasTerminal) this.cleanup();
    try {
      await this.fetchImpl(`${this.base}/api/meeting/recall/bots/${encodeURIComponent(this.id)}/leave`, { method: "POST" });
    } catch {
      /* best effort */
    }
  }

  private cleanup(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pollTimer) this.timers.clearInterval(this.pollTimer);
    if (this.tickTimer) this.timers.clearInterval(this.tickTimer);
    if (this.reconnectTimer) this.timers.clearTimeout(this.reconnectTimer);
    this.pollTimer = this.tickTimer = this.reconnectTimer = null;
    this.outbound = [];
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private emit(e: MeetingEvent): void {
    for (const l of this.listeners) l(e);
  }

  private get base(): string {
    return this.opts.brokerUrl.replace(/\/$/, "");
  }
}

/** Utility for tests / harnesses: builds a 16 kHz frame from an internal 48 kHz frame. */
export function toRecallPcm16(frame: PCMFrame): Int16Array {
  return float32ToInt16(createResampler(frame.sampleRate, 16_000).process(frame.data));
}

export { createFrame };
