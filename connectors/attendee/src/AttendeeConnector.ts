import { createFrame, createResampler, float32ToInt16, INTERNAL_SAMPLE_RATE, type PCMFrame } from "@rcai/audio-core";
import { detectPlatform, type JoinRequest, type MeetingConnector, type MeetingConnectorCapabilities, type MeetingEvent, type MeetingEventListener, type MeetingPlatform, type MeetingSession, type MeetingStatus } from "@rcai/meeting-core";
import { decodeChunk, encodeChunk, INBOUND_MIXED, INBOUND_PER_PARTICIPANT, OUTBOUND_AUDIO, type AttendeeAudioMessage } from "./protocol.js";

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

  async join(req: JoinRequest): Promise<MeetingSession> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`${this.opts.brokerUrl.replace(/\/$/, "")}/api/meeting/attendee/bots`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ meetingUrl: req.meetingUrl, botName: req.displayName, botPageQuery: req.options }),
    });
    const body = (await res.json().catch(() => ({}))) as { botId?: string; clientWsUrl?: string; sampleRate?: number; error?: string; detail?: string };
    if (!res.ok || !body.botId || !body.clientWsUrl) throw new Error(`${body.error ?? "attendee_join_failed"}${body.detail ? `: ${body.detail}` : ""}`);
    return new AttendeeSession(body.botId, detectPlatform(req.meetingUrl), body.clientWsUrl, body.sampleRate ?? 24000, this.opts);
  }
}

class AttendeeSession implements MeetingSession {
  private ws: WebSocketLike | null = null;
  private listeners = new Set<MeetingEventListener>();
  private state: MeetingStatus = "joining";
  private closed = false;
  /** The character speaks at the internal rate; Attendee takes whatever we told it we would send. */
  private readonly resampler = createResampler(INTERNAL_SAMPLE_RATE, 24000);

  constructor(
    readonly id: string,
    readonly platform: MeetingPlatform,
    private readonly clientWsUrl: string,
    private readonly sampleRate: number,
    private readonly opts: AttendeeConnectorOptions,
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
    if (msg?.trigger !== INBOUND_MIXED && msg?.trigger !== INBOUND_PER_PARTICIPANT) return;
    const chunk = msg.data?.chunk;
    if (!chunk) return;
    const pcm16 = decodeChunk(chunk);
    const float = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) float[i] = pcm16[i]! / 0x8000;
    this.emit({ type: "audio", frame: createFrame(float, msg.data?.sample_rate ?? this.sampleRate, this.now()) });
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
    if (this.closed) return;
    this.closed = true;
    this.ws?.close();
    this.ws = null;
    this.state = "left";
    this.emit({ type: "left", reason: "leave", at: this.now() });
  }
}
