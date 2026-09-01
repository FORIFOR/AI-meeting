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
  token: string;
  expiresAt?: number;
  model?: string;
}

export interface GeminiLiveProviderOptions {
  /** services/token-broker base URL (e.g. http://localhost:8787). */
  brokerUrl: string;
  model?: string;
  apiVersion?: "v1beta" | "v1alpha";
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
  /** Max automatic reconnect attempts after goAway / abnormal close (default 3). */
  maxReconnects?: number;
  /** Backoff base in ms (1000 → 1 s, 2 s, 4 s). */
  reconnectBackoffMs?: number;
}

const OPEN = 1;

/**
 * Gemini Live Adapter (spec §5): WSS BidiGenerateContent behind the common RealtimeAIProvider.
 * 16 kHz PCM in / 24 kHz PCM out are absorbed here; the app only sees 48 kHz Float32 frames.
 */
export class GeminiLiveProvider implements RealtimeAIProvider {
  readonly id = "google" as const;
  private listeners = new Set<ConversationEventListener>();
  /** Generation epoch: one generation per model turn; closed on turnComplete / interrupted. */
  private genCounter = new GenerationCounter();
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
  private userTranscript = "";
  private assistantTranscript = "";
  private endedTimer: ReturnType<typeof setTimeout> | null = null;
  private resumptionHandle: string | null = null;
  private reconnecting = false;
  private reconnectAttempts = 0;
  /** Diagnostics for harnesses. */
  readonly diagnostics = { reconnects: 0, reconnectFailures: 0 };

  constructor(private readonly opts: GeminiLiveProviderOptions) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.vad = opts.localVad === false ? null : new EnergyVAD();
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

  get model(): string {
    return this.opts.model ?? DEFAULT_GEMINI_LIVE_MODEL;
  }

  // ---- lifecycle ------------------------------------------------------------

  async connect(config: SessionConfig): Promise<void> {
    privacyGuard.assert(config.privacyMode, "cloud_conversation");
    this.config = config;
    this.closing = false;
    this.outbound = new OutboundAudioConverter({ targetRate: GEMINI_INPUT_RATE, chunkMs: 20 });
    this.inbound = new AudioNormalizer();
    this.vad?.reset();
    this.reconnectAttempts = 0;
    const token = await this.fetchToken();
    const model = token.model ?? this.model;
    await this.openSocket(geminiWssUrl(this.opts.apiVersion ?? "v1beta", token.token), model, config);
    this.emit({ type: "session_ready", providerId: this.id });
    // Opening line is owned by the provider (see integration contracts): ask for it as a client turn.
    const opening = (config.providerOptions?.opening as string | undefined)?.trim();
    if (opening) await this.sendText(`(セッション開始。最初に次の一言で会話を始めてください: 「${opening}」)`);
  }

  private async fetchToken(): Promise<GeminiTokenResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/token/gemini`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model }),
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
    // Enough to tell an auth problem from a wrong endpoint without ever printing the credential.
    const where = (() => {
      try {
        const u = new URL(url);
        const cred = u.searchParams.get("access_token") ?? u.searchParams.get("key");
        return `${u.pathname.split(".").slice(-3, -1).join(".")} cred=${cred ? `${cred.split("/")[0]}/…(${cred.length})` : "NONE"}`;
      } catch {
        return "unparseable url";
      }
    })();
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    const ws = factory(url);
    this.ws = ws;
    this.setupDone = false;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Gemini Live setup timed out")), this.opts.setupTimeoutMs ?? 10_000);
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        err ? reject(err) : resolve();
      };
      ws.onopen = () => {
        this.send({ setup: this.buildSetup(model, config) });
      };
      ws.onmessage = (ev) => {
        void this.decode(ev.data).then((msg) => {
          if (!msg) return;
          if (msg.setupComplete && !this.setupDone) {
            this.setupDone = true;
            done();
          }
          this.handleServerMessage(msg);
        });
      };
      ws.onerror = () => {
        done(new Error("Gemini Live websocket error"));
        if (this.setupDone) this.emit({ type: "error", error: new Error("Gemini Live websocket error") });
      };
      ws.onclose = (ev) => {
        done(new Error(`Gemini Live socket closed before setup [${where}] (${ev?.code ?? ""} ${ev?.reason ?? ""})`.trim()));
        if (this.ws !== ws) return; // stale socket (already replaced by a reconnect)
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
          ...(config.voice ? { voiceConfig: { prebuiltVoiceConfig: { voiceName: config.voice } } } : {}),
          // Native-audio models auto-detect language (docs); languageCode is only sent for half-cascade models.
          ...(nativeAudio ? {} : { languageCode: config.language }),
        },
        // Affective dialog is a native-audio feature: the newer live models reject the field outright
        // (1007 "Request contains an invalid argument"), which looks like a broken setup rather than an
        // unsupported option.
        ...(nativeAudio && (this.opts.enableAffectiveDialog ?? true) ? { enableAffectiveDialog: true } : {}),
      },
      systemInstruction: { parts: [{ text: instructions }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: this.opts.automaticActivityDetection ?? { disabled: false, silenceDurationMs: 500, prefixPaddingMs: 100 },
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
    if (config.tools?.length) {
      setup.tools = [{ functionDeclarations: config.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
    }
    if (this.resumptionHandle) setup.sessionResumption = { handle: this.resumptionHandle };
    return setup;
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.clearEndedTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === OPEN) {
      try {
        ws.close(1000, "client disconnect");
      } catch {
        /* ignore */
      }
    }
    this.setupDone = false;
  }

  // ---- input ------------------------------------------------------------------

  pushAudio(frame: PCMFrame): void {
    if (!this.outbound || !this.ws || this.ws.readyState !== OPEN || !this.setupDone) return;
    if (this.vad) {
      for (const ev of this.vad.process(frame)) {
        if (ev.type === "speech_start") {
          this.genCounter.nextTurn();
          this.emit({ type: "user_speech_started", at: ev.timestamp });
        }
        else this.emit({ type: "user_speech_ended", at: ev.timestamp });
      }
    }
    for (const chunk of this.outbound.push(frame)) {
      this.send({ realtimeInput: { audio: { data: bytesToBase64(int16ToBytes(chunk)), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } });
    }
  }

  pushImage(image: ImageFrame): void {
    if (!this.ws || this.ws.readyState !== OPEN || !this.setupDone) return;
    const data = typeof image.data === "string" ? image.data.replace(/^data:[^,]+,/, "") : bytesToBase64(image.data);
    this.send({ realtimeInput: { video: { data, mimeType: image.mimeType } } });
  }

  async sendText(text: string): Promise<void> {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: true } });
  }

  /**
   * Explicit interruption. Gemini has no dedicated cancel message; per the API reference a
   * clientContent message "will interrupt any current model generation". We send an empty,
   * non-turn-completing clientContent and drop local playback state immediately.
   */
  async interrupt(): Promise<void> {
    this.send({ clientContent: { turnComplete: false } });
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
      for (const fc of msg.toolCall.functionCalls) {
        this.emit({ type: "tool_call", call: { id: fc.id ?? fc.name, name: fc.name, arguments: fc.args ?? {} }, gen: this.genCounter.stamp() });
      }
    }
    if (msg.goAway) {
      this.emit({ type: "error", error: new Error(`Gemini Live goAway (timeLeft ${msg.goAway.timeLeft ?? "?"})`), fatal: false });
      void this.reconnect();
    }
    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      this.onInterrupted(now);
    }
    if (sc.inputTranscription?.text) {
      this.userTranscript += sc.inputTranscription.text;
      this.emit({ type: "user_transcript", text: this.userTranscript, final: false });
    }
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
      this.flushUserTranscript();
      if (this.assistantTranscript) {
        this.emit({ type: "assistant_transcript", text: this.assistantTranscript, final: true, gen: this.genCounter.stamp() });
      }
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
    if (!this.userTranscript.trim()) return;
    this.emit({ type: "user_transcript", text: this.userTranscript, final: true });
    this.userTranscript = "";
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
    const old = this.ws;
    this.clearEndedTimer();
    if (this.turn.hasAudio) this.onInterrupted(this.clock());
    this.emit({ type: "error", error: new Error(`Gemini Live: ${reason}; reconnecting`), fatal: false });
    const max = this.opts.maxReconnects ?? 3;
    const base = this.opts.reconnectBackoffMs ?? 1000;
    try {
      while (this.reconnectAttempts < max && !this.closing) {
        const attempt = ++this.reconnectAttempts;
        // goAway gives us a live socket for a while: try immediately, then back off.
        if (!(reason === "goAway" && attempt === 1)) await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
        if (this.closing) return;
        try {
          const token = await this.fetchToken();
          await this.openSocket(geminiWssUrl(this.opts.apiVersion ?? "v1beta", token.token), token.model ?? this.model, this.config);
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
          this.diagnostics.reconnectFailures++;
          this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)), fatal: false });
        }
      }
      if (!this.closing) {
        this.emit({ type: "error", error: new Error(`Gemini Live: reconnect failed after ${max} attempts`), fatal: true });
        this.emit({ type: "session_closed", reason: "reconnect exhausted" });
      }
    } finally {
      this.reconnecting = false;
    }
  }

  // ---- plumbing -------------------------------------------------------------------

  private send(msg: GeminiClientMessage): void {
    if (!this.ws || this.ws.readyState !== OPEN) return;
    this.ws.send(JSON.stringify(msg));
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
