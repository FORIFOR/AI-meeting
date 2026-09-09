import { createFrame, createResampler, float32ToInt16, INTERNAL_SAMPLE_RATE, type PCMFrame } from "@rcai/audio-core";
import { detectPlatform, type JoinRequest, type MeetingConnector, type MeetingConnectorCapabilities, type MeetingEvent, type MeetingEventListener, type MeetingPlatform, type MeetingSession, type MeetingStatus } from "@rcai/meeting-core";
import { decodeChunk, encodeChunk, INBOUND_MIXED, INBOUND_PER_PARTICIPANT, INBOUND_VIDEO, OUTBOUND_AUDIO, type AttendeeAudioMessage } from "./protocol.js";

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror?: ((e: unknown) => void) | null;
}

export interface AttendeeConnectorOptions {
  /** services/token-broker base URL. The API key never reaches this side. */
  brokerUrl: string;
  botPageQuery?: Record<string, string>;
  /** Application session, never a Zoom/provider secret. */
  authToken?: () => string | null;
  wsFactory?: (url: string) => WebSocketLike;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

/**
 * Attendee (app.attendee.dev) behind the same contract as Recall.
 *
 * The two providers differ in exactly one way that matters here: Attendee's audio socket carries the
 * character's voice *back*, so there is no separate clip endpoint and nothing to encode to mp3 — frames
 * go out as they are produced. Everything above this line (address detection, the conversation runtime,
 * the avatar) is unchanged, which is the point of the connector boundary.
 */
export class AttendeeConnector implements MeetingConnector {
  readonly id = "attendee" as MeetingConnector["id"];

  constructor(private readonly opts: AttendeeConnectorOptions) {}

  capabilities(): MeetingConnectorCapabilities {
    return {
      platforms: ["google_meet", "zoom", "teams"],
      audioOut: "pcm_stream",
      separateParticipantAudio: true,
      realtimeTranscript: false,
      videoOut: true,
    };
  }

  /**
   * Attach to a bot that already exists — the avatar page runs *inside* Attendee as the voice agent, so
   * it must not create a second bot; it joins the audio feed of the one carrying it.
   */
  attach(o: { botId: string; clientWsUrl: string; sampleRate?: number; platform?: MeetingPlatform }): MeetingSession {
    return new AttendeeSession(o.botId, o.platform ?? "google_meet", o.clientWsUrl, o.sampleRate ?? 24000, this.opts);
  }

  async join(req: JoinRequest): Promise<MeetingSession> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const token = this.opts.authToken?.();
    const res = await fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/meeting/attendee/bots`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ meetingUrl: req.meetingUrl, botName: req.displayName, botPageQuery: { ...this.opts.botPageQuery, ...req.options } }),
    });
    const body = (await res.json().catch(() => ({}))) as { botId?: string; clientWsUrl?: string; sampleRate?: number; error?: string; detail?: string };
    if (!res.ok || !body.botId || !body.clientWsUrl) {
      const zoomErrors: Record<string, string> = {
        ZOOM_LOGIN_REQUIRED: "先に「Zoomと連携」からログインしてください。",
        ZOOM_CONNECTION_REVOKED: "Zoomの連携が無効になりました。もう一度連携してください。",
        ZOOM_NOT_CONFIGURED: "Zoom連携の準備中です。時間をおいてお試しください。",
        ZOOM_PROVIDER_UNAVAILABLE: "Zoomの接続を確認できませんでした。時間をおいてお試しください。",
        ZOOM_CONNECTION_UNAVAILABLE: "Zoomの接続を確認できませんでした。時間をおいてお試しください。",
      };
      throw new Error(zoomErrors[body.error ?? ""] ?? `${body.error ?? "attendee_join_failed"}${body.detail ? `: ${body.detail}` : ""}`);
    }
    return new AttendeeSession(body.botId, detectPlatform(req.meetingUrl), body.clientWsUrl, body.sampleRate ?? 24000, this.opts, true);
  }
}

/** RMS of one per-participant chunk below this is silence: Meet's own suppression leaves an idle mic far under it. */
const PARTICIPANT_FLOOR_DB = -45;
/** How long a participant keeps the floor after their last audible chunk. */
const PARTICIPANT_HANGOVER_MS = 500;
/** A participant's loudness is reported at most this often: who is louder, not every 10 ms chunk. */
const PARTICIPANT_LEVEL_EVERY_MS = 100;

class AttendeeSession implements MeetingSession {
  private ws: WebSocketLike | null = null;
  private listeners = new Set<MeetingEventListener>();
  private state: MeetingStatus = "joining";
  private closed = false;
  private leaveRequest: Promise<void> | null = null;
  private remoteLeft = false;
  /** The character speaks at the internal rate; Attendee takes whatever we told it we would send. */
  private readonly resampler = createResampler(INTERNAL_SAMPLE_RATE, 24000);
  /** Participants whose own stream is currently above the floor, each with the timer that ends their turn. */
  private readonly talking = new Map<string, ReturnType<typeof setTimeout>>();
  /** When each participant's loudness was last reported (`speech_level`). */
  private readonly levelAt = new Map<string, number>();

  constructor(
    readonly id: string,
    readonly platform: MeetingPlatform,
    private readonly clientWsUrl: string,
    private readonly sampleRate: number,
    private readonly opts: AttendeeConnectorOptions,
    private readonly ownsBot = false,
  ) {
    this.resampler = createResampler(INTERNAL_SAMPLE_RATE, sampleRate);
    this.open();
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private emit(e: MeetingEvent): void {
    for (const l of this.listeners) l(e);
  }

  private open(): void {
    if (this.closed) return;
    const factory = this.opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WebSocketLike);
    const ws = factory(this.clientWsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.state = "in_call";
      this.emit({ type: "status", status: "in_call", detail: "attendee audio socket open", at: this.now() });
    };
    ws.onmessage = (ev) => this.onMessage(String((ev as { data: unknown }).data));
    ws.onclose = () => {
      if (this.closed) return;
      // The broker relay is between us and Attendee; a drop here is ours to retry, not the meeting ending.
      setTimeout(() => this.open(), 2000);
    };
  }

  /** Broker relay envelope: `{ relay: { botId }, message: <attendee frame> }`. */
  private onMessage(raw: string): void {
    let msg: AttendeeAudioMessage | undefined;
    try {
      const outer = JSON.parse(raw) as { relay?: { botId?: string }; message?: AttendeeAudioMessage; trigger?: string };
      if (outer.relay && outer.relay.botId !== this.id) return; // another bot's feed
      msg = outer.message ?? (outer as AttendeeAudioMessage);
    } catch {
      return;
    }
    /**
     * A webcam frame, not audio: the character reads nods and expressions from this. Emitted with the
     * participant it belongs to, because a reaction only means something when you know whose it is.
     */
    if (msg?.trigger === INBOUND_VIDEO) {
      const d = msg.data as { participant_uuid?: string; frame?: string } | undefined;
      if (d?.frame && d.participant_uuid) {
        this.emit({ type: "video_frame", participantId: d.participant_uuid, jpegBase64: d.frame, at: this.now() });
      }
      return;
    }
    if (msg?.trigger === INBOUND_PER_PARTICIPANT) {
      this.onParticipantChunk(msg);
      return;
    }
    if (msg?.trigger !== INBOUND_MIXED) return;
    const chunk = msg.data?.chunk;
    if (!chunk) return;
    const pcm16 = decodeChunk(chunk);
    const float = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float[i] = pcm16[i]! / 0x8000;
    this.emit({ type: "audio", frame: createFrame(float, msg.data?.sample_rate ?? this.sampleRate, this.now()) });
  }

  /**
   * A participant's own stream is *who* is talking, never a second copy of *what* they said.
   *
   * Attendee sends every voice twice: once in the mix and once on that person's socket. Both used to
   * reach the recogniser as room audio, interleaved — Gate #8 runs 6–8 heard 「ゆゆゆ今日もののいと…」
   * for 「ゆい、今日の予定を教えて」 and never answered to its name. The mix is the ears; this stream
   * only says whose turn it is, the way Recall's speech_on/off does, so a reply can be attached to a
   * person and the floor is known to be taken. A stream stays "active" while it is above the floor
   * and for a short hangover after — one quiet chunk between two syllables is not the end of a turn.
   */
  private onParticipantChunk(msg: AttendeeAudioMessage): void {
    const id = msg.data?.participant_uuid;
    const chunk = msg.data?.chunk;
    if (!id || !chunk) return;
    const pcm16 = decodeChunk(chunk);
    if (pcm16.length === 0) return;
    let sum = 0;
    for (let i = 0; i < pcm16.length; i++) {
      const v = pcm16[i]! / 0x8000;
      sum += v * v;
    }
    const db = 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / pcm16.length)));
    if (db < PARTICIPANT_FLOOR_DB) return;
    const now = this.now();
    if (now - (this.levelAt.get(id) ?? -Infinity) >= PARTICIPANT_LEVEL_EVERY_MS) {
      this.levelAt.set(id, now);
      this.emit({ type: "speech_level", participantId: id, level: db, at: now });
    }
    const timer = this.talking.get(id);
    if (timer) clearTimeout(timer);
    else this.emit({ type: "speech", participant: { id, name: null }, active: true, at: this.now() });
    this.talking.set(
      id,
      setTimeout(() => {
        this.talking.delete(id);
        this.emit({ type: "speech", participant: { id, name: null }, active: false, at: this.now() });
      }, PARTICIPANT_HANGOVER_MS),
    );
  }

  status(): MeetingStatus {
    return this.state;
  }

  onEvent(cb: MeetingEventListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  pushOutboundAudio(frame: PCMFrame): void {
    const ws = this.ws;
    if (!ws || this.closed) return;
    const resampled = this.resampler.process(frame.data);
    if (resampled.length === 0) return;
    ws.send(JSON.stringify({ trigger: OUTBOUND_AUDIO, data: { chunk: encodeChunk(float32ToInt16(resampled)), sample_rate: this.sampleRate } }));
  }

  /** Nothing to flush: audio leaves as it is produced, which is the whole reason for this provider. */
  async endOutboundUtterance(): Promise<void> {}

  async leave(): Promise<void> {
    if (this.ownsBot && !this.remoteLeft) {
      if (!this.leaveRequest) this.leaveRequest = (async () => {
        const response = await (this.opts.fetchImpl ?? fetch)(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/meeting/attendee/bots/${encodeURIComponent(this.id)}/leave`, { method: "POST", signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error("Botの退出を確認できませんでした。もう一度退出してください。");
        this.remoteLeft = true;
      })().finally(() => { this.leaveRequest = null; });
      await this.leaveRequest;
    }
    if (this.closed) return;
    this.closed = true;
    for (const t of this.talking.values()) clearTimeout(t);
    this.talking.clear();
    this.ws?.close();
    this.ws = null;
    this.state = "left";
    this.emit({ type: "left", reason: "leave", at: this.now() });
  }
}
