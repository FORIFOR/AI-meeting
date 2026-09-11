import { INTERNAL_SAMPLE_RATE, createResampler, type PCMFrame } from "@rcai/audio-core";
import { conversationPolicyFor, type ConversationContext, type ConversationEvent, type ConversationEventListener, type SessionConfig } from "@rcai/conversation-core";
import { privacyGuard, type ProviderCapabilities, type RealtimeAIProvider } from "@rcai/provider-core";
import { OpenAIEventMapper, type OpenAIServerEvent } from "./events.js";
import { openaiPromptAdapter } from "./prompt.js";

export interface OpenAIRealtimeProviderOptions {
  /** services/token-broker base URL, e.g. http://localhost:8787 */
  brokerUrl: string;
  model?: string;
  defaultVoice?: string;
  /** "server_vad" (default) or "semantic_vad" */
  turnDetection?: "server_vad" | "semantic_vad";
  fetch?: typeof fetch;
  /** Injectable for tests / non-browser runtimes. */
  createPeerConnection?: () => RTCPeerConnection;
  /** Injectable for the pushAudio fallback (creates the AudioContext lazily). */
  createAudioContext?: () => AudioContext;
  clock?: () => number;
  /** Total connection setup deadline, including broker, SDP and data-channel open (ms). */
  connectTimeoutMs?: number;
  /** Max automatic reconnect attempts after ICE/connection failure (default 3). */
  maxReconnects?: number;
  /** Backoff base in ms (1000 → 1 s, 2 s, 4 s). */
  reconnectBackoffMs?: number;
  /** Emit assistant_speech_ended if no stop/clear event arrives this long after the last speech activity (default 30 s). */
  speechEndedTimeoutMs?: number;
  /** Grace period for a "disconnected" ICE state before reconnecting (default 3 s). */
  disconnectedGraceMs?: number;
}

interface BrokerToken {
  clientSecret: string;
  expiresAt: number;
  model: string;
  baseUrl: string;
}

/**
 * Spec §4: Microphone → WebRTC → OpenAI Realtime → audio track → SpeakerOutput.
 * API keys never touch this class; it only ever sees an ephemeral client secret.
 * Endpoints verified 2026-08-30 (developers.openai.com/api/docs/guides/realtime-webrtc):
 *   POST {baseUrl}/calls  (Content-Type: application/sdp, Authorization: Bearer <ephemeral>)
 */
export class OpenAIRealtimeProvider implements RealtimeAIProvider {
  readonly id = "openai" as const;
  private listeners = new Set<ConversationEventListener>();
  private mapper = new OpenAIEventMapper();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private inputStream: MediaStream | null = null;
  private outputStream: MediaStream | null = null;
  private config: SessionConfig | null = null;
  private fetchImpl: typeof fetch;
  private clock: () => number;
  private senders: RTCRtpSender[] = [];
  // pushAudio fallback (no mic MediaStream attached)
  private fallbackCtx: AudioContext | null = null;
  private fallbackDest: MediaStreamAudioDestinationNode | null = null;
  private fallbackNext = 0;
  private fallbackResampler = createResampler(INTERNAL_SAMPLE_RATE, INTERNAL_SAMPLE_RATE);
  private connected = false;
  private closing = false;
  private sessionEpoch = 0;
  private sessionAbort = new AbortController();
  // Persistent output: remote tracks are routed into one MediaStreamDestination so the runtime's
  // sink keeps a single stream across reconnects (the runtime attaches the output stream only once).
  private outputCtx: AudioContext | null = null;
  private outputDest: MediaStreamAudioDestinationNode | null = null;
  private outputSource: MediaStreamAudioSourceNode | null = null;
  private remoteAudioEl: HTMLAudioElement | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private lastInstructions = "";
  private lastVoice: string | undefined;
  private speechTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Diagnostics for harnesses (reconnect count etc.). */
  readonly diagnostics = { reconnects: 0, reconnectFailures: 0, connectionStates: [] as string[] };

  constructor(private readonly opts: OpenAIRealtimeProviderOptions) {
    this.fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  }

  capabilities(): ProviderCapabilities {
    return {
      nativeAudio: true,
      vision: true, // conversation.item.create with input_image is supported by gpt-realtime
      toolCalling: true,
      realtimeTranscript: true,
      interruption: true,
      emotionUnderstanding: false,
      localOnly: false,
      extras: { webrtc: true, semanticVad: true },
    };
  }

  onEvent(callback: ConversationEventListener): void {
    this.listeners.add(callback);
  }

  /** Provide the mic MediaStream (preferred; avoids re-encoding). Call before connect(). */
  attachInputStream(stream: MediaStream): void {
    this.inputStream = stream;
    if (this.pc && this.senders.length === 0) {
      for (const track of stream.getAudioTracks()) this.senders.push(this.pc.addTrack(track, stream));
    } else if (this.pc && this.senders[0]) {
      const track = stream.getAudioTracks()[0];
      if (track) void this.senders[0].replaceTrack(track);
    }
  }

  getOutputStream(): MediaStream | null {
    return this.outputStream;
  }

  async connect(config: SessionConfig): Promise<void> {
    privacyGuard.assert(config.privacyMode, "cloud_conversation");
    const disconnected = this.disconnect();
    const epoch = this.sessionEpoch;
    await disconnected;
    if (epoch !== this.sessionEpoch) throw new Error("openai realtime: connection cancelled");
    this.sessionAbort = new AbortController();
    this.closing = false;
    this.config = config;
    this.reconnectAttempts = 0;
    await this.openConnection(config);
    if (this.closing || epoch !== this.sessionEpoch) throw new Error("openai realtime: connection cancelled");
    this.emit({ type: "session_ready", providerId: this.id });
    const opening = (config.providerOptions?.opening as string | undefined)?.trim();
    if (opening) this.send({ type: "response.create", response: { instructions: `Start the conversation by saying, in your own voice: ${opening}` } });
  }

  /** Token → peer connection → data channel → SDP → session.update. Shared by connect() and reconnect(). */
  private async openConnection(config: SessionConfig): Promise<void> {
    this.mapper.reset();
    this.clearSpeechTimer();
    const instructions = this.instructionsFor(config);
    const voice = config.voice ?? this.opts.defaultVoice;
    const model = config.model ?? this.opts.model;
    this.lastInstructions = instructions;
    this.lastVoice = voice;

    const epoch = this.sessionEpoch;
    const sessionSignal = this.sessionAbort.signal;
    const setupAbort = new AbortController();
    const cancel = () => setupAbort.abort(new Error("openai realtime: connection cancelled"));
    sessionSignal.addEventListener("abort", cancel, { once: true });
    if (sessionSignal.aborted) cancel();
    const timer = setTimeout(() => setupAbort.abort(new Error("openai realtime: connection setup timed out")), this.opts.connectTimeoutMs ?? 15000);
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      rejectCancelled = () => reject(setupAbort.signal.reason);
      setupAbort.signal.addEventListener("abort", rejectCancelled, { once: true });
      if (setupAbort.signal.aborted) rejectCancelled();
    });
    void cancelled.catch(() => {});
    // Race every setup step as WebRTC operations and injected fetches may ignore abort signals.
    // A late completion cannot resume setup after cancellation or mutate a newer connection.
    const wait = async <T>(pending: Promise<T>): Promise<T> => {
      const value = await Promise.race([pending, cancelled]);
      if (setupAbort.signal.aborted) throw setupAbort.signal.reason;
      if (this.closing || epoch !== this.sessionEpoch) throw new Error("openai realtime: connection cancelled");
      return value;
    };
    let pc: RTCPeerConnection | null = null;
    let dc: RTCDataChannel | null = null;
    try {
      // 1. Ephemeral credential from the broker (never an API key).
      const tokenRes = await wait(this.fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/token/openai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, voice, instructions, language: config.language }),
        signal: setupAbort.signal,
      }));
      if (!tokenRes.ok) {
        const body = (await wait(tokenRes.json().catch(() => ({})))) as { error?: string };
        throw new Error(body.error ?? `token broker ${tokenRes.status}`);
      }
      const token = (await wait(tokenRes.json())) as BrokerToken;

      // 2. Peer connection + tracks.
      pc = (this.opts.createPeerConnection ?? (() => new RTCPeerConnection()))();
      this.pc = pc;
      const ownsConnection = () => !this.closing && epoch === this.sessionEpoch && this.pc === pc;
      this.senders = [];
      pc.ontrack = (ev) => {
        if (!ownsConnection()) return;
        this.routeRemoteTrack(ev.streams[0] ?? new MediaStream([ev.track]));
      };
      pc.onconnectionstatechange = () => {
        if (!ownsConnection()) return;
        if (this.connected) this.onConnectionState(pc!);
        else if (pc!.connectionState === "failed") setupAbort.abort(new Error("openai realtime: connection failed during setup"));
      };
      const input = this.inputStream ?? this.ensureFallbackInput();
      if (input) for (const track of input.getAudioTracks()) this.senders.push(pc.addTrack(track, input));
      else pc.addTransceiver("audio", { direction: "recvonly" });

      // 3. Events data channel.
      dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.onmessage = (ev: MessageEvent<string>) => { if (ownsConnection() && this.dc === dc) this.handleRaw(ev.data); };
      dc.onclose = () => {
        if (!ownsConnection() || this.dc !== dc) return;
        if (!this.connected) setupAbort.abort(new Error("openai realtime: data channel closed during setup"));
        if (this.connected && !this.reconnecting && !this.closing) this.emit({ type: "session_closed", reason: "data channel closed" });
        this.connected = false;
      };
      const opened = new Promise<void>((resolve) => {
        dc!.onopen = () => { if (ownsConnection()) resolve(); };
      });

      // 4. SDP exchange with the ephemeral secret.
      const offer = await wait(pc.createOffer());
      await wait(pc.setLocalDescription(offer));
      const callsUrl = `${token.baseUrl.replace(/\/$/, "")}/calls?model=${encodeURIComponent(token.model)}`;
      const sdpRes = await wait(this.fetchImpl(callsUrl, {
        method: "POST",
        body: offer.sdp ?? "",
        headers: { Authorization: `Bearer ${token.clientSecret}`, "Content-Type": "application/sdp" },
        signal: setupAbort.signal,
      }));
      if (!sdpRes.ok) throw new Error(`openai realtime calls ${sdpRes.status}: ${(await wait(sdpRes.text().catch(() => ""))).slice(0, 200)}`);
      const sdp = await wait(sdpRes.text());
      await wait(pc.setRemoteDescription({ type: "answer", sdp }));
      await wait(opened);
      this.connected = true;

      // 5. Session settings (transcription, VAD, instructions, voice).
      this.send({ type: "session.update", session: this.sessionPatch(instructions, voice) });
    } catch (error) {
      if (pc && this.pc === pc) this.teardownConnection();
      throw error;
    } finally {
      clearTimeout(timer);
      sessionSignal.removeEventListener("abort", cancel);
      setupAbort.signal.removeEventListener("abort", rejectCancelled);
      if (dc) dc.onopen = null;
    }
  }

  // ---- reconnection ---------------------------------------------------------

  private onConnectionState(pc: RTCPeerConnection): void {
    if (this.pc !== pc) return;
    const state = pc.connectionState;
    this.diagnostics.connectionStates.push(state);
    if (state === "connected") {
      if (this.disconnectGraceTimer) {
        clearTimeout(this.disconnectGraceTimer);
        this.disconnectGraceTimer = null;
      }
      return;
    }
    if (state === "failed") {
      void this.reconnect(`connection ${state}`);
    } else if (state === "disconnected") {
      // ICE "disconnected" often self-heals; give it a moment before tearing down.
      if (this.disconnectGraceTimer) return;
      this.disconnectGraceTimer = setTimeout(() => {
        this.disconnectGraceTimer = null;
        if (this.pc === pc && pc.connectionState !== "connected" && !this.closing) void this.reconnect("connection disconnected");
      }, this.opts.disconnectedGraceMs ?? 3000);
    }
  }

  /** Up to `maxReconnects` attempts with exponential backoff; the runtime re-attaches nothing — the output stream is stable. */
  private async reconnect(reason: string): Promise<void> {
    if (this.reconnecting || this.closing || !this.config) return;
    this.reconnecting = true;
    const epoch = this.sessionEpoch;
    const config = this.config;
    this.clearSpeechTimer();
    if (this.mapper.isSpeaking) this.emit({ type: "interrupted", at: this.clock() });
    this.emit({ type: "error", error: new Error(`openai realtime: ${reason}; reconnecting`), fatal: false });
    const max = this.opts.maxReconnects ?? 3;
    const base = this.opts.reconnectBackoffMs ?? 1000;
    try {
      while (this.reconnectAttempts < max && !this.closing && epoch === this.sessionEpoch) {
        const attempt = ++this.reconnectAttempts;
        await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
        if (this.closing || epoch !== this.sessionEpoch) return;
        this.teardownConnection();
        try {
          await this.openConnection(config);
          if (this.closing || epoch !== this.sessionEpoch) return;
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
        this.connected = false;
        this.emit({ type: "error", error: new Error(`openai realtime: reconnect failed after ${max} attempts`), fatal: true });
        this.emit({ type: "session_closed", reason: "reconnect exhausted" });
      }
    } finally {
      if (epoch === this.sessionEpoch) this.reconnecting = false;
    }
  }

  /** Close the current peer connection / data channel without touching the persistent output. */
  private teardownConnection(): void {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
    if (this.dc) {
      this.dc.onopen = null;
      this.dc.onmessage = null;
      this.dc.onclose = null;
    }
    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
    }
    try {
      this.dc?.close();
    } catch {
      /* ignore */
    }
    this.dc = null;
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.senders = [];
    this.connected = false;
    if (this.outputSource) {
      this.outputSource.disconnect();
      this.outputSource = null;
    }
  }

  /** Remote track → (persistent destination) → getOutputStream(). Falls back to the raw stream without WebAudio. */
  private routeRemoteTrack(stream: MediaStream): void {
    const make = this.opts.createAudioContext ?? (typeof AudioContext !== "undefined" ? () => new AudioContext({ sampleRate: INTERNAL_SAMPLE_RATE }) : null);
    if (!make) {
      this.outputStream = stream;
      return;
    }
    if (!this.outputCtx) {
      this.outputCtx = make();
      this.outputDest = this.outputCtx.createMediaStreamDestination();
      this.outputStream = this.outputDest.stream;
    }
    if (this.outputSource) this.outputSource.disconnect();
    this.outputSource = this.outputCtx.createMediaStreamSource(stream);
    this.outputSource.connect(this.outputDest!);
    // Chrome only delivers remote WebRTC audio into WebAudio while the stream is bound to a media element.
    if (typeof document !== "undefined") {
      if (!this.remoteAudioEl) {
        this.remoteAudioEl = document.createElement("audio");
        this.remoteAudioEl.muted = true;
        this.remoteAudioEl.autoplay = true;
        this.remoteAudioEl.style.display = "none";
        document.body?.appendChild(this.remoteAudioEl);
      }
      this.remoteAudioEl.srcObject = stream;
      void this.remoteAudioEl.play?.()?.catch?.(() => {});
    }
    if (this.outputCtx.state === "suspended") void this.outputCtx.resume().catch(() => {});
  }

  // ---- speech-ended safety timer -------------------------------------------------

  private armSpeechTimer(): void {
    this.clearSpeechTimer();
    const ms = this.opts.speechEndedTimeoutMs ?? 30_000;
    this.speechTimer = setTimeout(() => {
      this.speechTimer = null;
      if (!this.mapper.isSpeaking) return;
      // Synthesize the missing stop through the mapper so its state stays consistent.
      for (const ev of this.mapper.map({ type: "output_audio_buffer.stopped" } as OpenAIServerEvent, this.clock())) this.emit(ev);
    }, ms);
  }

  private clearSpeechTimer(): void {
    if (this.speechTimer) clearTimeout(this.speechTimer);
    this.speechTimer = null;
  }

  /** Frames are only needed when no MediaStream was attached (fallback path). */
  pushAudio(frame: PCMFrame): void {
    if (this.inputStream || !this.connected) return;
    this.ensureFallbackInput();
    const dest = this.fallbackDest;
    const ctx = this.fallbackCtx;
    if (!dest || !ctx) return;
    const data = frame.sampleRate === ctx.sampleRate ? frame.data : this.fallbackResampler.process(frame.data);
    const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
    buf.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(dest);
    const start = Math.max(this.fallbackNext, ctx.currentTime + 0.02);
    src.start(start);
    this.fallbackNext = start + buf.duration;
  }

  pushImage(image: { data: Uint8Array | string; mimeType: string }): void {
    if (!this.connected) return;
    const url = typeof image.data === "string" ? image.data : `data:${image.mimeType};base64,${bytesToBase64(image.data)}`;
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_image", image_url: url }] } });
  }

  async sendText(text: string): Promise<void> {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
  }

  /**
   * Stop generation and flush any audio still buffered on the WebRTC side. The active response is
   * marked cancelled so its late events (deltas, done, buffer stops) are dropped by the mapper.
   */
  async interrupt(): Promise<void> {
    // Only cancel something that exists: cancelling nothing is an error the session does not survive.
    if (this.mapper.hasActiveResponse) this.send({ type: "response.cancel" });
    this.send({ type: "output_audio_buffer.clear" });
    this.mapper.markCancelled();
  }

  async updateContext(context: ConversationContext): Promise<void> {
    if (!this.config) return;
    this.config = { ...this.config, systemPrompt: context.systemPrompt, mode: context.mode, language: context.language };
    this.send({ type: "session.update", session: { type: "realtime", instructions: this.instructionsFor(this.config) } });
  }

  async disconnect(): Promise<void> {
    const wasConnected = this.connected;
    this.closing = true;
    this.sessionEpoch++;
    this.sessionAbort.abort();
    this.reconnecting = false;
    this.config = null;
    this.clearSpeechTimer();
    this.teardownConnection();
    this.outputStream = null;
    if (this.remoteAudioEl) {
      this.remoteAudioEl.srcObject = null;
      this.remoteAudioEl.remove();
      this.remoteAudioEl = null;
    }
    // Release ownership before awaiting close: an older disconnect must not clear a newer
    // connection's contexts when two starts/stops overlap.
    const outputCtx = this.outputCtx;
    const fallbackCtx = this.fallbackCtx;
    this.outputCtx = null;
    this.outputDest = null;
    this.fallbackCtx = null;
    this.fallbackDest = null;
    this.fallbackNext = 0;
    if (wasConnected) this.emit({ type: "session_closed" });
    await Promise.all([outputCtx?.close().catch(() => {}), fallbackCtx?.close().catch(() => {})]);
  }

  // ---- internals ---------------------------------------------------------

  /** Exposed for tests: feed a raw server event JSON string. */
  handleRaw(data: string): void {
    let raw: OpenAIServerEvent;
    try {
      raw = JSON.parse(data) as OpenAIServerEvent;
    } catch {
      return;
    }
    for (const ev of this.mapper.map(raw, this.clock())) {
      if (ev.type === "assistant_speech_started" || ev.type === "assistant_transcript") this.armSpeechTimer();
      else if (ev.type === "assistant_speech_ended" || ev.type === "interrupted") this.clearSpeechTimer();
      this.emit(ev);
    }
  }

  private instructionsFor(config: SessionConfig): string {
    return openaiPromptAdapter.adapt(config.systemPrompt, conversationPolicyFor(config.language));
  }

  private sessionPatch(instructions: string, voice: string | undefined): Record<string, unknown> {
    const lang = this.config?.language?.split("-")[0];
    const turn =
      (this.opts.turnDetection ?? "server_vad") === "semantic_vad"
        ? { type: "semantic_vad", eagerness: "auto", create_response: true, interrupt_response: true }
        : { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500, create_response: true, interrupt_response: true };
    const patch: Record<string, unknown> = {
      type: "realtime",
      instructions,
      output_modalities: ["audio"],
      audio: {
        input: { transcription: { model: "gpt-live-transcribe", ...(lang ? { languages: [lang] } : {}) }, turn_detection: turn },
        ...(voice ? { output: { voice } } : {}),
      },
    };
    if (this.config?.tools?.length) {
      patch.tools = this.config.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
      patch.tool_choice = "auto";
    }
    return patch;
  }

  private ensureFallbackInput(): MediaStream | null {
    if (this.fallbackDest) return this.fallbackDest.stream;
    const make = this.opts.createAudioContext ?? (typeof AudioContext !== "undefined" ? () => new AudioContext({ sampleRate: INTERNAL_SAMPLE_RATE }) : null);
    if (!make) return null;
    this.fallbackCtx = make();
    this.fallbackDest = this.fallbackCtx.createMediaStreamDestination();
    this.fallbackResampler = createResampler(INTERNAL_SAMPLE_RATE, this.fallbackCtx.sampleRate);
    return this.fallbackDest.stream;
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.dc || this.dc.readyState !== "open") return;
    this.dc.send(JSON.stringify(payload));
  }

  private emit(e: ConversationEvent): void {
    for (const l of this.listeners) l(e);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
