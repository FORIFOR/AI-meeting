import { OutboundAudioConverter, INTERNAL_SAMPLE_RATE, createFrame, createResampler, int16ToFloat32, type PCMFrame, type Resampler } from "@rcai/audio-core";
import type { ConversationContext, ConversationEvent, ConversationEventListener, GenerationRef, SessionConfig } from "@rcai/conversation-core";
import { PrivacyViolationError, type ProviderCapabilities, type RealtimeAIProvider } from "@rcai/provider-core";
import { isLoopbackUrl } from "./loopback.js";

export interface LocalProviderOptions {
  /** e.g. ws://127.0.0.1:8788 (http(s) is converted to ws(s)). */
  agentUrl: string;
  /** WebSocket constructor override (tests / node). */
  WebSocketImpl?: typeof WebSocket;
  /** Connect timeout ms (default 5000). */
  connectTimeoutMs?: number;
}

interface WireGen {
  turnId: number;
  generationId: number;
  sequence: number;
}

type AgentMessage =
  | { type: "ready"; protocolVersion?: number }
  | { type: "user_speech_started" }
  | { type: "user_speech_ended" }
  | { type: "user_transcript"; text: string; final: boolean }
  | { type: "assistant_thinking"; gen?: WireGen }
  | { type: "assistant_speech_started"; gen?: WireGen }
  | { type: "assistant_transcript"; text: string; final: boolean; gen?: WireGen }
  | { type: "assistant_speech_ended"; gen?: WireGen }
  | { type: "interrupted"; gen?: WireGen }
  | { type: "metrics"; turn: import("@rcai/conversation-core").TurnMetrics; gen?: WireGen }
  | { type: "error"; message: string };

/** Agent binary audio header (protocol v2): [u32 rate][u32 generationId][u32 sequence]. */
export const AGENT_AUDIO_HEADER_BYTES = 12;

export function toWsUrl(agentUrl: string, path = "/session"): string {
  const u = new URL(agentUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : u.protocol === "http:" ? "ws:" : u.protocol;
  u.pathname = path;
  u.search = "";
  return u.toString();
}

/**
 * Local Provider (spec §6): the browser side of the "Local Bus". All heavy lifting
 * (VAD/STT/LLM/TTS) runs in services/agent on the same machine.
 */
export class LocalProvider implements RealtimeAIProvider {
  readonly id = "local" as const;
  private ws: WebSocket | null = null;
  private listeners: ConversationEventListener[] = [];
  private outbound = new OutboundAudioConverter({ targetRate: 16000, chunkMs: 20 });
  private resamplers = new Map<number, Resampler>();
  private readonly WS: typeof WebSocket;
  /** Session id used in GenerationRef stamps (new per connect). */
  private sessionId = "";
  private lastGen: WireGen = { turnId: 0, generationId: 0, sequence: 0 };

  constructor(private readonly opts: LocalProviderOptions) {
    this.WS = opts.WebSocketImpl ?? (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket;
  }

  capabilities(): ProviderCapabilities {
    return { nativeAudio: false, vision: false, toolCalling: false, realtimeTranscript: true, interruption: true, emotionUnderstanding: false, localOnly: true, extras: { offline: true } };
  }

  onEvent(callback: ConversationEventListener): void {
    this.listeners.push(callback);
  }

  private emit(e: ConversationEvent): void {
    for (const l of this.listeners) l(e);
  }

  async connect(config: SessionConfig): Promise<void> {
    if (config.privacyMode === "strict_local" && !isLoopbackUrl(this.opts.agentUrl)) {
      throw new PrivacyViolationError("cloud_conversation");
    }
    const url = toWsUrl(this.opts.agentUrl);
    this.sessionId = `local_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    this.lastGen = { turnId: 0, generationId: 0, sequence: 0 };
    const ws = new this.WS(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`agent connect timeout: ${url}`)), this.opts.connectTimeoutMs ?? 5000);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "start", config }));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`agent connection failed: ${url}`));
      };
      ws.onmessage = (ev: MessageEvent) => {
        if (typeof ev.data === "string") {
          const msg = JSON.parse(ev.data) as AgentMessage;
          if (msg.type === "ready") {
            clearTimeout(timer);
            ws.onmessage = (e2: MessageEvent) => this.handleMessage(e2);
            this.emit({ type: "session_ready", providerId: this.id });
            resolve();
          } else if (msg.type === "error") {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        }
      };
      ws.onclose = () => {
        this.emit({ type: "session_closed" });
      };
    });
  }

  private handleMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      const msg = JSON.parse(ev.data) as AgentMessage;
      switch (msg.type) {
        case "user_speech_started":
        case "user_speech_ended":
          this.emit({ type: msg.type });
          break;
        case "assistant_thinking":
        case "assistant_speech_started":
        case "assistant_speech_ended":
          this.emit({ type: msg.type, gen: this.toGen(msg.gen) });
          break;
        case "interrupted":
          this.emit({ type: "interrupted", gen: this.toGen(msg.gen) });
          break;
        case "user_transcript":
          this.emit({ type: msg.type, text: msg.text, final: msg.final });
          break;
        case "assistant_transcript":
          this.emit({ type: msg.type, text: msg.text, final: msg.final, gen: this.toGen(msg.gen) });
          break;
        case "metrics":
          this.emit({ type: "metrics", turn: msg.turn, gen: this.toGen(msg.gen) });
          break;
        case "error":
          this.emit({ type: "error", error: new Error(msg.message) });
          break;
        default:
          break;
      }
      return;
    }
    const bytes = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : new Uint8Array(ev.data as ArrayBufferLike);
    const decoded = this.decodeAudio(bytes);
    this.emit({ type: "assistant_audio", frame: decoded, gen: decoded.gen });
  }

  /** Wire gen → GenerationRef (sessionId is provider-local). Missing gen → last seen. */
  private toGen(g?: WireGen): GenerationRef {
    if (g) this.lastGen = g;
    const w = g ?? this.lastGen;
    return { sessionId: this.sessionId, turnId: w.turnId, generationId: w.generationId, sequence: w.sequence };
  }

  /** [u32 rate][u32 generationId][u32 sequence][Int16 LE PCM] → internal 48k frame (+gen). */
  decodeAudio(bytes: Uint8Array): PCMFrame & { gen: GenerationRef } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleRate = view.getUint32(0, true);
    const generationId = view.getUint32(4, true);
    const sequence = view.getUint32(8, true);
    const body = bytes.subarray(AGENT_AUDIO_HEADER_BYTES);
    const aligned = new Uint8Array(body.byteLength - (body.byteLength % 2));
    aligned.set(body.subarray(0, aligned.length));
    const f32 = int16ToFloat32(new Int16Array(aligned.buffer));
    let r = this.resamplers.get(sampleRate);
    if (!r) {
      r = createResampler(sampleRate, INTERNAL_SAMPLE_RATE);
      this.resamplers.set(sampleRate, r);
    }
    const gen: GenerationRef = { sessionId: this.sessionId, turnId: this.lastGen.turnId, generationId, sequence };
    this.lastGen = { turnId: this.lastGen.turnId, generationId, sequence };
    return { ...createFrame(r.process(f32), INTERNAL_SAMPLE_RATE), gen };
  }

  pushAudio(frame: PCMFrame): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    for (const chunk of this.outbound.push(frame)) {
      this.ws.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
    }
  }

  /**
   * A text turn is the one message the caller is waiting on an answer for, so losing it must be an
   * error, not silence: on a bot page the arrival greeting raced the agent socket and vanished here
   * (Gate #8 run 9 — the page sat ADDRESSED for 27 s waiting for a reply the agent never received).
   */
  async sendText(text: string): Promise<void> {
    if (!this.send({ type: "text", text })) throw new Error(`agent socket not open (readyState=${this.ws?.readyState ?? "none"})`);
  }

  async interrupt(): Promise<void> {
    this.send({ type: "interrupt" });
  }

  async updateContext(context: ConversationContext): Promise<void> {
    this.send({ type: "update_context", context });
  }

  async disconnect(): Promise<void> {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "stop" }));
      ws.close();
    } catch {
      /* ignore */
    }
    this.outbound = new OutboundAudioConverter({ targetRate: 16000, chunkMs: 20 });
    this.resamplers.clear();
  }

  private send(msg: object): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }
}
