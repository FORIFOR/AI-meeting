import { OutboundAudioConverter, bytesToBase64, int16ToBytes, type PCMFrame } from "@rcai/audio-core";
import type { AvatarProvider, AvatarState, CharacterDefinition, Emotion, Gesture, GazeTarget } from "@rcai/avatar-core";

/**
 * Tavus CVI realistic avatar (docs.tavus.io).
 * Server (token broker): POST https://tavusapi.com/v2/conversations (x-api-key) → { conversation_id, conversation_url }.
 * Client: joins the Daily room at `conversation_url` and drives the replica with the Interactions Protocol
 * over Daily app messages (`call.sendAppMessage(msg, "*")`):
 *   conversation.echo     { properties: { modality: "audio", audio: <base64>, sample_rate, inference_id, done } }  (PAL must use pipeline_mode "echo")
 *   conversation.echo     { properties: { modality: "text", text } }
 *   conversation.interrupt
 *   conversation.respond  { properties: { text } }
 * Observable: conversation.started_speaking / conversation.stopped_speaking (properties.role "pal"|"user"|"replica"),
 *             conversation.utterance, conversation.replica.started_speaking (legacy).
 * Spec §17: no MotionStack — Tavus animates internally.
 */

export interface TavusConversation {
  conversationId: string;
  conversationUrl: string;
}

/** Subset of the Daily call object used here (injectable for tests). */
export interface DailyCallLike {
  join(opts: { url: string; token?: string }): Promise<unknown>;
  leave(): Promise<unknown>;
  destroy(): Promise<unknown>;
  on(event: string, cb: (ev: unknown) => void): unknown;
  sendAppMessage(msg: unknown, to?: string): unknown;
  setLocalAudio(enabled: boolean): unknown;
  setLocalVideo(enabled: boolean): unknown;
}

export interface TavusAvatarOptions {
  brokerUrl: string;
  container: HTMLElement;
  personaId?: string;
  replicaId?: string;
  fetch?: typeof fetch;
  callFactory?: () => Promise<DailyCallLike>;
  /** Echo audio chunk size (ms). Default 200. */
  chunkMs?: number;
  /** Echo sample rate (Hz). Tavus accepts 16000 (default) or higher; we send 24000. */
  sampleRate?: number;
  /** Publish the local microphone into the Daily room (only for Tavus-managed ASR). Default false: our runtime owns the conversation. */
  publishMic?: boolean;
}

export type TavusEvent =
  | { type: "avatar_speech_started" }
  | { type: "avatar_speech_ended" }
  | { type: "user_speech_started" }
  | { type: "user_speech_ended" }
  | { type: "utterance"; role: string; text: string }
  | { type: "error"; error: Error };

interface AppMessage {
  message_type: "conversation";
  event_type: string;
  conversation_id: string;
  properties?: Record<string, unknown>;
}

export class TavusAvatarProvider implements AvatarProvider {
  readonly id = "tavus";
  private conversation: TavusConversation | null = null;
  private call: DailyCallLike | null = null;
  private video: HTMLVideoElement | null = null;
  private audio: HTMLAudioElement | null = null;
  private converter: OutboundAudioConverter;
  private readonly sampleRate: number;
  private inferenceId: string | null = null;
  private inferenceSeq = 0;
  private state: AvatarState = "IDLE";
  private listeners = new Set<(e: TavusEvent) => void>();
  private readonly fetchImpl: typeof fetch;
  /** App messages sent (tests/debug). */
  readonly sent: AppMessage[] = [];

  constructor(private readonly opts: TavusAvatarOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.sampleRate = opts.sampleRate ?? 24_000;
    this.converter = new OutboundAudioConverter({ targetRate: this.sampleRate, chunkMs: opts.chunkMs ?? 200 });
  }

  onEvent(cb: (e: TavusEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async prepare(character: CharacterDefinition): Promise<void> {
    const res = await this.fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/avatar/tavus/conversation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ personaId: this.opts.personaId, replicaId: this.opts.replicaId ?? character.model, conversationName: character.manifest.name }),
    });
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "BLOCKED_BY_TAVUS_KEY");
    }
    if (!res.ok) throw new Error(`tavus conversation failed: ${res.status}`);
    const d = (await res.json()) as Record<string, unknown>;
    const conversationId = (d.conversationId ?? d.conversation_id) as string | undefined;
    const conversationUrl = (d.conversationUrl ?? d.conversation_url) as string | undefined;
    if (!conversationId || !conversationUrl) throw new Error("tavus response missing conversation_id / conversation_url");
    this.conversation = { conversationId, conversationUrl };
  }

  async start(): Promise<void> {
    if (!this.conversation) throw new Error("prepare() first");
    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.muted = true; // audio goes through a separate element so autoplay policies allow video
    Object.assign(this.video.style, { width: "100%", height: "100%", objectFit: "cover" });
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.opts.container.append(this.video, this.audio);

    this.call = await (this.opts.callFactory ?? defaultCallFactory)();
    this.call.on("track-started", (ev) => this.onTrack(ev as { participant?: { local?: boolean }; track?: MediaStreamTrack }));
    this.call.on("app-message", (ev) => this.onAppMessage(ev as { data?: AppMessage }));
    this.call.on("error", (ev) => this.emit({ type: "error", error: new Error(String((ev as { errorMsg?: string })?.errorMsg ?? "daily error")) }));
    await this.call.join({ url: this.conversation.conversationUrl });
    this.call.setLocalVideo(false);
    this.call.setLocalAudio(this.opts.publishMic ?? false);
  }

  private onTrack(ev: { participant?: { local?: boolean }; track?: MediaStreamTrack }): void {
    if (!ev.track || ev.participant?.local) return;
    const stream = new MediaStream([ev.track]);
    if (ev.track.kind === "video" && this.video) this.video.srcObject = stream;
    else if (ev.track.kind === "audio" && this.audio) this.audio.srcObject = stream;
  }

  private onAppMessage(ev: { data?: AppMessage }): void {
    const msg = ev.data;
    if (!msg || msg.message_type !== "conversation") return;
    const role = String(msg.properties?.role ?? "");
    switch (msg.event_type) {
      case "conversation.started_speaking":
        this.emit({ type: role === "user" ? "user_speech_started" : "avatar_speech_started" });
        break;
      case "conversation.stopped_speaking":
        this.emit({ type: role === "user" ? "user_speech_ended" : "avatar_speech_ended" });
        break;
      case "conversation.replica.started_speaking":
      case "conversation.replica_started_speaking":
        this.emit({ type: "avatar_speech_started" });
        break;
      case "conversation.replica.stopped_speaking":
      case "conversation.replica_stopped_speaking":
        this.emit({ type: "avatar_speech_ended" });
        break;
      case "conversation.utterance":
        this.emit({ type: "utterance", role, text: String(msg.properties?.speech ?? msg.properties?.text ?? "") });
        break;
      default:
        break;
    }
  }

  /**
   * Assistant PCM → `conversation.echo` audio chunks (base64 PCM16 @ sampleRate).
   * Requires a PAL created with `pipeline_mode: "echo"` (Tavus Echo Mode). Feed assistant frames, not the speaker tap,
   * and mute local playback: the replica's Daily audio track is the synchronized output.
   */
  pushAudio(frame: PCMFrame): void {
    if (!this.call || !this.conversation) return;
    if (!this.inferenceId) this.inferenceId = `inf_${++this.inferenceSeq}_${Date.now().toString(36)}`;
    for (const chunk of this.converter.push(frame)) this.sendEchoAudio(chunk, false);
  }

  /** Mark the current utterance complete (`done: true`). */
  endSpeech(): void {
    if (!this.inferenceId) return;
    const rest = this.converter.flush();
    this.sendEchoAudio(rest ?? new Int16Array(0), true);
    this.inferenceId = null;
  }

  /** Text echo: the replica speaks `text` verbatim via Tavus TTS (works without echo-mode audio). */
  speakText(text: string): void {
    this.send("conversation.echo", { modality: "text", text });
  }

  /** Feed text as if the user said it (Tavus-managed LLM path; not used by our runtime). */
  respondTo(text: string): void {
    this.send("conversation.respond", { text });
  }

  private sendEchoAudio(chunk: Int16Array, done: boolean): void {
    this.send("conversation.echo", {
      modality: "audio",
      audio: bytesToBase64(int16ToBytes(chunk)),
      sample_rate: this.sampleRate,
      inference_id: this.inferenceId,
      done,
    });
  }

  setState(state: AvatarState): void {
    const prev = this.state;
    this.state = state;
    if (prev === "SPEAKING" && state !== "SPEAKING" && state !== "INTERRUPTED") this.endSpeech();
    if (state === "INTERRUPTED") this.interrupt();
  }

  /** Tavus renders its own facial animation; not controllable through CVI. */
  setEmotion(_emotion: Emotion, _intensity: number): void {}
  performGesture(_gesture: Gesture, _intensity: number): void {}
  setGaze(_target: GazeTarget): void {}

  interrupt(): void {
    this.converter.flush();
    this.inferenceId = null;
    this.send("conversation.interrupt");
  }

  async stop(): Promise<void> {
    await this.call?.leave().catch(() => {});
    await this.call?.destroy().catch(() => {});
    this.call = null;
    this.video?.remove();
    this.audio?.remove();
    this.video = null;
    this.audio = null;
    if (this.conversation) {
      // Best-effort: POST /v2/conversations/{id}/end via the broker (ignored if the route is absent).
      await this.fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/avatar/tavus/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId: this.conversation.conversationId }),
      }).catch(() => undefined);
    }
    this.conversation = null;
  }

  get currentConversation(): TavusConversation | null {
    return this.conversation;
  }

  private send(eventType: string, properties?: Record<string, unknown>): void {
    if (!this.call || !this.conversation) return;
    const msg: AppMessage = { message_type: "conversation", event_type: eventType, conversation_id: this.conversation.conversationId };
    if (properties) msg.properties = properties;
    this.sent.push(msg);
    this.call.sendAppMessage(msg, "*");
  }

  private emit(e: TavusEvent): void {
    for (const l of this.listeners) l(e);
  }
}

async function defaultCallFactory(): Promise<DailyCallLike> {
  const mod = await import("@daily-co/daily-js");
  const Daily = (mod.default ?? mod) as unknown as { createCallObject(opts?: Record<string, unknown>): DailyCallLike };
  return Daily.createCallObject({ subscribeToTracksAutomatically: true });
}
