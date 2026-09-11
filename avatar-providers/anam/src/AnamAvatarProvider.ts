import { OutboundAudioConverter, int16ToBytes, type PCMFrame } from "@rcai/audio-core";
import type { AvatarProvider, AvatarState, CharacterDefinition, Emotion, Gesture, GazeTarget, SynchronizedAvatarAudio } from "@rcai/avatar-core";
import type { AnamEvent, EventCallbacks } from "@anam-ai/js-sdk";

export interface AnamAudioInputLike {
  sendAudioChunk(data: ArrayBuffer | Uint8Array | string): void;
  endSequence(): void;
}

/** Public SDK subset. Injection permits lifecycle tests without opening paid sessions. */
export interface AnamClientLike {
  stream(): Promise<MediaStream[]>;
  createAgentAudioInputStream(config: { encoding: "pcm_s16le"; sampleRate: number; channels: number }): AnamAudioInputLike;
  interruptPersona(): void;
  stopStreaming(): Promise<void>;
  addListener<K extends AnamEvent>(event: K, listener: EventCallbacks[K]): void;
  removeListener<K extends AnamEvent>(event: K, listener: EventCallbacks[K]): void;
}

export interface AnamAvatarOptions {
  container: HTMLElement;
  brokerUrl: string;
  privacyMode?: "default" | "strict_local";
  fetch?: typeof fetch;
  clientFactory?: (token: string, options: { disableInputAudio: true }) => AnamClientLike | Promise<AnamClientLike>;
  startupTimeoutMs?: number;
}

interface Run {
  abort: AbortController;
  token: string | null;
  client: AnamClientLike | null;
  input: AnamAudioInputLike | null;
  converter: OutboundAudioConverter;
  sequenceOpen: boolean;
  ready: boolean;
  interrupted: boolean;
  failed: boolean;
  disposed: boolean;
  starting: boolean;
  output: MediaStream | null;
  tracks: Set<MediaStreamTrack>;
  detach: Array<() => void>;
  video: HTMLVideoElement | null;
  audio?: SynchronizedAvatarAudio;
  listeners: Set<(error: Error) => void>;
}

const converter = () => new OutboundAudioConverter({ targetRate: 16_000, chunkMs: 20 });
const event = <K extends AnamEvent>(name: `${K}`): K => name as K;

/** External audio in, synchronized AV out. The ordinary speaker tap never feeds Anam. */
export class AnamAvatarProvider implements AvatarProvider {
  readonly id = "anam";
  private run: Run | null = null;
  private generation = 0;

  constructor(private readonly options: AnamAvatarOptions) {}

  get synchronizedAudio(): SynchronizedAvatarAudio | undefined {
    return this.run?.ready ? this.run.audio : undefined;
  }

  async prepare(character: CharacterDefinition): Promise<void> {
    const generation = ++this.generation;
    const previous = this.run;
    this.run = null;
    if (previous) await this.dispose(previous);
    if (this.generation !== generation) throw new Error("ANAM_CANCELLED");
    if (this.options.privacyMode === "strict_local") throw new Error("ANAM_REQUIRES_CLOUD");
    const run: Run = {
      abort: new AbortController(), token: null, client: null, input: null,
      converter: converter(), sequenceOpen: false, ready: false, interrupted: false,
      failed: false, disposed: false, starting: false, output: null,
      tracks: new Set(), detach: [], video: null, listeners: new Set(),
    };
    run.audio = {
      pushSourceAudio: (frame) => this.pushSourceAudio(run, frame),
      endSourceTurn: () => this.endSourceTurn(run),
      getOutputStream: () => this.run === run && run.ready ? run.output : null,
      onFailure: (listener) => {
        run.listeners.add(listener);
        return () => { run.listeners.delete(listener); };
      },
    };
    this.run = run;
    try {
      await this.bounded(run, (async () => {
        const response = await (this.options.fetch ?? fetch)(`${this.options.brokerUrl.replace(/\/$/, "")}/api/avatar/anam/session`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ characterId: character.manifest.id, privacyMode: this.options.privacyMode ?? "default" }),
          signal: run.abort.signal,
        });
        this.assertCurrent(run);
        if (!response.ok) throw new Error(`ANAM_SESSION_HTTP_${response.status}`);
        const body: unknown = await response.json();
        this.assertCurrent(run);
        const token = (body as { sessionToken?: unknown } | null)?.sessionToken;
        if (typeof token !== "string" || !token.trim()) throw new Error("ANAM_SESSION_INVALID_RESPONSE");
        run.token = token;
      })());
    } catch (error) {
      const safe = this.safeError(error, "ANAM_SESSION_FAILED");
      if (!run.disposed) this.fail(run, safe);
      throw safe;
    }
  }

  async start(): Promise<void> {
    const run = this.run;
    if (!run || run.disposed) throw new Error("ANAM_PREPARE_REQUIRED");
    if (run.ready) return;
    if (!run.token) throw new Error("ANAM_PREPARE_REQUIRED");
    if (run.starting) throw new Error("ANAM_ALREADY_STARTING");
    run.starting = true;
    try {
      await this.bounded(run, this.startRun(run));
      this.assertCurrent(run);
      run.ready = true;
    } catch (error) {
      const safe = this.safeError(error, "ANAM_START_FAILED");
      if (!run.disposed) this.fail(run, safe);
      throw safe;
    } finally {
      run.starting = false;
    }
  }

  private async startRun(run: Run): Promise<void> {
    const client = await (this.options.clientFactory ?? defaultClientFactory)(run.token!, { disableInputAudio: true });
    run.token = null;
    if (run.disposed || this.run !== run) {
      void this.stopClient(client);
      throw new Error("ANAM_CANCELLED");
    }
    run.client = client;
    this.listen(run, event("CONNECTION_CLOSED"), () => this.fail(run, new Error("ANAM_CONNECTION_CLOSED")));
    this.listen(run, event("VIDEO_STREAM_STARTED"), (stream) => this.capture(run, stream));
    this.listen(run, event("AUDIO_STREAM_STARTED"), (stream) => this.capture(run, stream));
    const streams = await client.stream();
    for (const stream of streams) this.capture(run, stream);
    if (run.disposed || this.run !== run) {
      void this.stopClient(client); // A stream can resolve after the first cancellation cleanup.
      throw new Error("ANAM_CANCELLED");
    }
    const tracks = [...run.tracks].filter((track) => track.readyState !== "ended");
    if (!tracks.some((t) => t.kind === "audio") || !tracks.some((t) => t.kind === "video")) {
      throw new Error("ANAM_MEDIA_TRACKS_MISSING");
    }
    run.output = new MediaStream(tracks);
    run.input = client.createAgentAudioInputStream({ encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 });
    const video = this.options.container.ownerDocument.createElement("video");
    run.video = video;
    // Decoder/playback errors can occur after startup while SDK tracks are still live.
    // Keep this listener for the video's lifetime so the owner can select its local renderer.
    const playbackFailed = () => this.fail(run, new Error("ANAM_VIDEO_FAILED"));
    video.addEventListener("error", playbackFailed);
    run.detach.push(() => video.removeEventListener("error", playbackFailed));
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute("aria-label", "AIアバター");
    Object.assign(video.style, { width: "100%", height: "100%", objectFit: "contain" });
    // Muting the element keeps the tracks usable by SpeakerOutput / the meeting connector.
    video.srcObject = run.output;
    this.options.container.append(video);
    await video.play();
    this.assertCurrent(run);
    if (video.readyState < 2) {
      await new Promise<void>((resolve, reject) => {
        const loaded = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("ANAM_VIDEO_FAILED")); };
        const cleanup = () => {
          video.removeEventListener("loadeddata", loaded);
          video.removeEventListener("error", failed);
        };
        run.detach.push(cleanup);
        video.addEventListener("loadeddata", loaded, { once: true });
        video.addEventListener("error", failed, { once: true });
        if (video.readyState >= 2) loaded();
      });
    }
    this.assertCurrent(run);
  }

  private listen<K extends AnamEvent>(run: Run, name: K, handler: EventCallbacks[K]): void {
    const client = run.client!;
    client.addListener(name, handler);
    run.detach.push(() => client.removeListener(name, handler));
  }

  private capture(run: Run, stream: MediaStream): void {
    for (const track of stream.getTracks()) {
      if (run.disposed || this.run !== run) { track.stop(); continue; }
      if ([...run.tracks].some((existing) => existing.id === track.id)) continue;
      run.tracks.add(track);
      const ended = () => this.fail(run, new Error("ANAM_MEDIA_ENDED"));
      track.addEventListener("ended", ended);
      run.detach.push(() => track.removeEventListener("ended", ended));
    }
  }

  private pushSourceAudio(run: Run, frame: PCMFrame): void {
    if (this.run !== run || !run.ready || !run.input || run.interrupted || !frame.data.length) return;
    try {
      run.sequenceOpen = true;
      for (const chunk of run.converter.push(frame)) run.input.sendAudioChunk(int16ToBytes(chunk));
    } catch { this.fail(run, new Error("ANAM_AUDIO_SEND_FAILED")); }
  }

  private endSourceTurn(run: Run): void {
    if (this.run !== run || !run.ready || !run.input || !run.sequenceOpen || run.interrupted) return;
    run.sequenceOpen = false;
    try {
      const remaining = run.converter.flush();
      if (remaining?.length) run.input.sendAudioChunk(int16ToBytes(remaining));
      run.input.endSequence();
      run.converter = converter();
    } catch { this.fail(run, new Error("ANAM_AUDIO_END_FAILED")); }
  }

  /** SpeakerOutput.tap is observation only; feeding it upstream would form an audio loop. */
  pushAudio(_frame: PCMFrame): void {}
  setState(_state: AvatarState): void {}
  setEmotion(_emotion: Emotion, _intensity: number): void {}
  performGesture(_gesture: Gesture, _intensity: number): void {}
  setGaze(_target: GazeTarget): void {}

  interrupt(): void {
    const run = this.run;
    if (!run || run.disposed || run.interrupted) return;
    run.interrupted = true;
    run.converter = converter(); // Drop, never flush interrupted input into a later turn.
    run.sequenceOpen = false;
    try { run.client?.interruptPersona(); } catch { /* Stop/fallback remains authoritative. */ }
    try { run.input?.endSequence(); } catch { /* Never allow failed interruption to resume this session. */ }
    // The SDK has no passthrough turn ID/interrupt ACK; the owner must stop/fallback this session.
    this.fail(run, new Error("ANAM_INTERRUPTED_REQUIRES_LOCAL_FALLBACK"));
  }

  async stop(): Promise<void> {
    this.generation++;
    const run = this.run;
    if (!run) return;
    this.run = null;
    await this.dispose(run);
  }

  private fail(run: Run, error: Error): void {
    if (run.failed || run.disposed || this.run !== run) return;
    run.failed = true;
    const listeners = [...run.listeners];
    void this.dispose(run);
    for (const listener of listeners) {
      try { listener(error); } catch { /* A consumer must not prevent media cleanup. */ }
    }
  }

  private async dispose(run: Run): Promise<void> {
    if (run.disposed) return;
    run.disposed = true;
    run.ready = false;
    run.token = null;
    run.input = null;
    run.output = null;
    run.sequenceOpen = false;
    run.converter = converter();
    run.listeners.clear();
    run.abort.abort();
    for (const detach of run.detach.splice(0)) { try { detach(); } catch { /* best effort */ } }
    if (run.video) {
      run.video.pause();
      run.video.srcObject = null;
      run.video.remove();
      run.video = null;
    }
    for (const track of run.tracks) track.stop();
    run.tracks.clear();
    const client = run.client;
    run.client = null;
    if (client) await this.stopClient(client);
  }

  private async stopClient(client: AnamClientLike): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => client.stopStreaming()).catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private assertCurrent(run: Run): void {
    if (run.disposed || this.run !== run) throw new Error("ANAM_CANCELLED");
  }

  private async bounded<T>(run: Run, task: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<never>((_, reject) => {
          aborted = () => reject(new Error("ANAM_CANCELLED"));
          run.abort.signal.addEventListener("abort", aborted, { once: true });
          if (run.abort.signal.aborted) aborted();
          timer = setTimeout(() => reject(new Error("ANAM_STARTUP_TIMEOUT")), Math.max(1, this.options.startupTimeoutMs ?? 9_000));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (aborted) run.abort.signal.removeEventListener("abort", aborted);
    }
  }

  private safeError(error: unknown, fallback: string): Error {
    const message = error instanceof Error ? error.message : "";
    return new Error(/^ANAM_[A-Z_]+(?:_\d{3})?$/.test(message) ? message : fallback);
  }
}

async function defaultClientFactory(token: string, options: { disableInputAudio: true }): Promise<AnamClientLike> {
  const { createClient } = await import("@anam-ai/js-sdk");
  return createClient(token, { ...options, api: { retry: { maxAttempts: 1 }, requestTimeoutMs: 8_000 } });
}
