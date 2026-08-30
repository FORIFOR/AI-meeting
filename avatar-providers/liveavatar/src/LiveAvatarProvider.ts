import { OutboundAudioConverter, bytesToBase64, int16ToBytes, type PCMFrame } from "@rcai/audio-core";
import type { AvatarProvider, AvatarState, CharacterDefinition, Emotion, Gesture, GazeTarget } from "@rcai/avatar-core";

/**
 * HeyGen LiveAvatar (LITE / custom mode) — docs.liveavatar.com.
 * Flow (server side via token broker): POST /v1/sessions/token {mode:"LITE", avatar_id} → session_token,
 * POST /v1/sessions/start (Bearer session_token) → { session_id, livekit_url, livekit_client_token, ws_url }.
 * Client: LiveKit room carries the avatar's audio+video; the WebSocket (`ws_url`) takes commands:
 *   { type: "agent.speak", audio: <base64 PCM16 24kHz> } · { type: "agent.speak_end", event_id }
 *   { type: "agent.interrupt" } · { type: "agent.start_listening" | "agent.stop_listening", event_id } · { type: "session.keep_alive", event_id }
 * and emits { type: "agent.speak_started" | "agent.speak_ended", ... } / { type: "session.state_updated", state }.
 * Spec §17: this provider never uses the MotionStack; HeyGen animates internally.
 */

export interface LiveAvatarSession {
  sessionId: string;
  /** LiveKit URL (`livekit_url`). */
  livekitUrl: string;
  /** LiveKit client token (`livekit_client_token`). */
  livekitClientToken: string;
  /** Command WebSocket (`ws_url`, custom/LITE mode). */
  wsUrl?: string;
}

/** Minimal structural interfaces so tests can inject fakes (livekit-client `Room` / WebSocket satisfy them). */
export interface RoomLike {
  connect(url: string, token: string): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
}
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface LiveAvatarOptions {
  brokerUrl: string;
  container: HTMLElement;
  /** HeyGen avatar id; defaults to `character.model`. */
  avatarId?: string;
  fetch?: typeof fetch;
  roomFactory?: () => Promise<RoomLike>;
  socketFactory?: (url: string) => SocketLike;
  /** Audio chunk size sent to the avatar (ms). Docs recommend ~1 s; 200 ms keeps lip latency low. */
  chunkMs?: number;
  keepAliveMs?: number;
}

export type LiveAvatarEvent =
  | { type: "avatar_speech_started" }
  | { type: "avatar_speech_ended" }
  | { type: "session_state"; state: string }
  | { type: "error"; error: Error };

const WS_OPEN = 1;

export class LiveAvatarProvider implements AvatarProvider {
  readonly id = "liveavatar";
  private session: LiveAvatarSession | null = null;
  private room: RoomLike | null = null;
  private socket: SocketLike | null = null;
  private video: HTMLVideoElement | null = null;
  private converter: OutboundAudioConverter;
  private speaking = false;
  private state: AvatarState = "IDLE";
  private listeners = new Set<(e: LiveAvatarEvent) => void>();
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private eventSeq = 0;
  private character: CharacterDefinition | null = null;
  private readonly fetchImpl: typeof fetch;
  /** Commands sent (for tests/debug). */
  readonly sent: Record<string, unknown>[] = [];

  constructor(private readonly opts: LiveAvatarOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.converter = new OutboundAudioConverter({ targetRate: 24_000, chunkMs: opts.chunkMs ?? 200 });
  }

  onEvent(cb: (e: LiveAvatarEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async prepare(character: CharacterDefinition): Promise<void> {
    this.character = character;
    const res = await this.fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/avatar/heygen/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ avatarId: this.opts.avatarId ?? character.model, mode: "LITE" }),
    });
    if (res.status === 503) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "BLOCKED_BY_HEYGEN_KEY");
    }
    if (!res.ok) throw new Error(`heygen session failed: ${res.status}`);
    const json = (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown> };
    const d = { ...(json.data ?? {}), ...json } as Record<string, unknown>;
    const livekitUrl = (d.livekitUrl ?? d.livekit_url ?? d.url) as string | undefined;
    const token = (d.livekitClientToken ?? d.livekit_client_token ?? d.accessToken ?? d.access_token) as string | undefined;
    const sessionId = (d.sessionId ?? d.session_id) as string | undefined;
    if (!livekitUrl || !token || !sessionId) throw new Error("heygen session response missing livekit_url / livekit_client_token / session_id");
    this.session = { sessionId, livekitUrl, livekitClientToken: token, wsUrl: (d.wsUrl ?? d.ws_url) as string | undefined };
  }

  async start(): Promise<void> {
    if (!this.session) throw new Error("prepare() first");
    this.video = document.createElement("video");
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.style.width = "100%";
    this.video.style.height = "100%";
    this.video.style.objectFit = "cover";
    this.opts.container.appendChild(this.video);

    this.room = await (this.opts.roomFactory ?? defaultRoomFactory)();
    this.room.on("trackSubscribed", (track) => {
      const t = track as { kind?: string; attach?: (el?: HTMLMediaElement) => HTMLMediaElement };
      if (!t.attach) return;
      if (t.kind === "video" && this.video) t.attach(this.video);
      else if (t.kind === "audio") {
        const el = t.attach();
        el.style.display = "none";
        this.opts.container.appendChild(el);
      }
    });
    await this.room.connect(this.session.livekitUrl, this.session.livekitClientToken);

    if (this.session.wsUrl) {
      await this.openSocket(this.session.wsUrl);
      this.keepAlive = setInterval(() => this.send({ type: "session.keep_alive", event_id: this.nextId() }), this.opts.keepAliveMs ?? 30_000);
    } else {
      this.emit({ type: "error", error: new Error("LiveAvatar session has no ws_url: audio-driven speech unavailable (use LITE/custom mode token)") });
    }
  }

  private openSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (this.opts.socketFactory ?? ((u: string) => new WebSocket(u) as unknown as SocketLike))(url);
      this.socket = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => {
        this.emit({ type: "error", error: new Error("LiveAvatar websocket error") });
        reject(e instanceof Error ? e : new Error("websocket error"));
      };
      ws.onclose = () => this.emit({ type: "session_state", state: "closed" });
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type?: string; state?: string };
          if (msg.type === "agent.speak_started") this.emit({ type: "avatar_speech_started" });
          else if (msg.type === "agent.speak_ended") this.emit({ type: "avatar_speech_ended" });
          else if (msg.type === "session.state_updated" && msg.state) this.emit({ type: "session_state", state: msg.state });
        } catch {
          /* ignore non-JSON */
        }
      };
      if (ws.readyState === WS_OPEN) resolve();
    });
  }

  /**
   * Assistant PCM (internal 48k float) → PCM16 24k base64 `agent.speak` chunks.
   * NOTE: feed this with the assistant audio frames (not the local speaker tap) and mute local playback —
   * the avatar's LiveKit track carries the synchronized audio back to the user (spec §17).
   */
  pushAudio(frame: PCMFrame): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.speaking = true;
    for (const chunk of this.converter.push(frame)) {
      this.send({ type: "agent.speak", audio: bytesToBase64(int16ToBytes(chunk)) });
    }
  }

  /** Flush the pending chunk and tell the avatar the utterance is complete. */
  endSpeech(): void {
    if (!this.speaking) return;
    const rest = this.converter.flush();
    if (rest && rest.length > 0) this.send({ type: "agent.speak", audio: bytesToBase64(int16ToBytes(rest)) });
    this.send({ type: "agent.speak_end", event_id: this.nextId() });
    this.speaking = false;
  }

  setState(state: AvatarState): void {
    const prev = this.state;
    this.state = state;
    if (prev === "SPEAKING" && state !== "SPEAKING" && state !== "INTERRUPTED") this.endSpeech();
    if (state === "LISTENING" && prev !== "LISTENING") this.send({ type: "agent.start_listening", event_id: this.nextId() });
    if (prev === "LISTENING" && state !== "LISTENING") this.send({ type: "agent.stop_listening", event_id: this.nextId() });
    if (state === "INTERRUPTED") this.interrupt();
  }

  /** HeyGen renders its own facial animation; emotion/gesture/gaze are not exposed by the LITE API. */
  setEmotion(_emotion: Emotion, _intensity: number): void {}
  performGesture(_gesture: Gesture, _intensity: number): void {}
  setGaze(_target: GazeTarget): void {}

  interrupt(): void {
    this.converter.flush();
    this.speaking = false;
    this.send({ type: "agent.interrupt" });
  }

  async stop(): Promise<void> {
    if (this.keepAlive) clearInterval(this.keepAlive);
    this.keepAlive = null;
    this.socket?.close();
    this.socket = null;
    await this.room?.disconnect().catch(() => {});
    this.room = null;
    this.video?.remove();
    this.video = null;
    if (this.session) {
      // Best-effort server-side stop (POST /v1/sessions/stop via the broker). Ignored if the broker lacks the route.
      await this.fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/avatar/heygen/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: this.session.sessionId, reason: "USER_CLOSED" }),
      }).catch(() => undefined);
    }
    this.session = null;
  }

  get currentSession(): LiveAvatarSession | null {
    return this.session;
  }

  get currentCharacter(): CharacterDefinition | null {
    return this.character;
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return;
    this.sent.push(msg);
    this.socket.send(JSON.stringify(msg));
  }

  private nextId(): string {
    return `ev_${++this.eventSeq}`;
  }

  private emit(e: LiveAvatarEvent): void {
    for (const l of this.listeners) l(e);
  }
}

async function defaultRoomFactory(): Promise<RoomLike> {
  const { Room } = await import("livekit-client");
  return new Room({ adaptiveStream: true, dynacast: true }) as unknown as RoomLike;
}
