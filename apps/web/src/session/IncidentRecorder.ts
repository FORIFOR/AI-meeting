import { OutboundAudioConverter, dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import type { ConversationEvent } from "@rcai/conversation-core";
import type { AvatarProvider, AvatarParams, StateTransition } from "@rcai/avatar-core";
import type { SessionObserver } from "@rcai/observability";

/** One timestamped entry of the presence ring buffer (Round 3 Gate 6). */
export type IncidentEntry =
  | { t: number; kind: "event"; type: string; text?: string; final?: boolean; gen?: unknown; providerId?: string; fatal?: boolean; code?: string }
  | { t: number; kind: "state"; from: string; to: string; event: string }
  | { t: number; kind: "motion"; layer: string; clip: string | null }
  | { t: number; kind: "emotion"; emotion: string; intensity: number }
  | { t: number; kind: "gesture"; gesture: string; intensity: number }
  | { t: number; kind: "gaze"; target: string }
  | { t: number; kind: "vad"; level: number }
  | { t: number; kind: "latency"; name: string; ms: number }
  | { t: number; kind: "error"; code?: string; message: string }
  | { t: number; kind: "provider"; providerId: string }
  | { t: number; kind: "stale"; drops: number };

export interface IncidentOptIn {
  audio: boolean;
  video: boolean;
}

export interface PresenceIncident {
  id: string;
  sessionId: string;
  at: number;
  /** Total window (±windowMs/2 around `at`). */
  windowMs: number;
  reason: string;
  note?: string;
  provider: string | null;
  avatarState: string;
  /** Entries within the window, oldest first, relative `t` in ms from `at`. */
  entries: (IncidentEntry & { rel: number })[];
  hud: unknown;
  userOptIn: IncidentOptIn;
  /** Base64 WAV (16 kHz mono PCM16) — only present when the tester opted in. */
  micWavBase64?: string;
  assistantWavBase64?: string;
  /** Base64 JPEG of the self camera at capture time — only when opted in and the camera is on. */
  videoFrameJpegBase64?: string;
  mode?: string;
  characterId?: string;
}

export interface IncidentRecorderOptions {
  sessionId: () => string;
  clock?: () => number;
  /** Ring buffer length (ms). Default 20 s. */
  keepMs?: number;
  /** Incident window (ms) around the tap. Default 10 s (±5 s). */
  windowMs?: number;
  /** Audio ring length (ms) for opt-in capture. Default 5 s. */
  audioMs?: number;
  observer?: SessionObserver;
  getHud?: () => unknown;
  getProvider?: () => string | null;
  getAvatarState?: () => string;
  getVideoElement?: () => HTMLVideoElement | null;
  meta?: { mode?: string; characterId?: string };
}

const RING_RATE = 16_000;

/**
 * Keeps the last ~20 s of everything that shapes "presence" (events, avatar state, motion,
 * emotion, gaze, VAD, latency, errors) so a tester's 「不自然だった瞬間」 tap can be turned into
 * one self-contained incident. Audio/video are captured ONLY after an explicit opt-in.
 */
export class IncidentRecorder {
  private entries: IncidentEntry[] = [];
  private clock: () => number;
  private keepMs: number;
  private windowMs: number;
  private optIn: IncidentOptIn = { audio: false, video: false };
  private micRing: Int16Ring | null = null;
  private assistantRing: Int16Ring | null = null;
  private micConv = new OutboundAudioConverter({ targetRate: RING_RATE, chunkMs: 20 });
  private asstConv = new OutboundAudioConverter({ targetRate: RING_RATE, chunkMs: 20 });
  private lastVadAt = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private raf: number | null = null;
  private lastFrameAt = 0;
  private lastClips: Record<string, string | null> = {};
  private lipPending: number | null = null;
  private lipLastAudioLoudAt = 0;
  private mouthWasOpen = false;
  readonly incidents: PresenceIncident[] = [];
  private seq = 0;

  constructor(private readonly opts: IncidentRecorderOptions) {
    this.clock = opts.clock ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.keepMs = opts.keepMs ?? 20_000;
    this.windowMs = opts.windowMs ?? 10_000;
  }

  get optInState(): IncidentOptIn {
    return { ...this.optIn };
  }

  /** Explicit opt-in (default OFF). Audio rings are allocated only when enabled and cleared when disabled. */
  setOptIn(next: Partial<IncidentOptIn>): void {
    this.optIn = { ...this.optIn, ...next };
    if (this.optIn.audio) {
      const n = Math.round(((this.opts.audioMs ?? 5000) / 1000) * RING_RATE);
      this.micRing ??= new Int16Ring(n);
      this.assistantRing ??= new Int16Ring(n);
    } else {
      this.micRing = null;
      this.assistantRing = null;
    }
  }

  // ---- feeds --------------------------------------------------------------
  recordEvent(e: ConversationEvent): void {
    const t = this.clock();
    const gen = (e as { gen?: unknown }).gen;
    switch (e.type) {
      case "assistant_audio":
        return; // too chatty; the assistant audio ring covers it
      case "user_transcript":
      case "assistant_transcript":
        this.push({ t, kind: "event", type: e.type, text: e.text.slice(0, 200), final: e.final, gen });
        return;
      case "error":
        this.push({ t, kind: "event", type: e.type, fatal: e.fatal, code: /BLOCKED_BY_[A-Z_]+/.exec(e.error.message)?.[0], text: e.error.message.slice(0, 200) });
        return;
      case "session_ready":
        this.push({ t, kind: "event", type: e.type, providerId: e.providerId });
        return;
      default:
        this.push({ t, kind: "event", type: e.type, gen });
    }
  }

  recordState(tr: StateTransition): void {
    this.push({ t: this.clock(), kind: "state", from: tr.from, to: tr.to, event: tr.event });
  }

  recordError(message: string, code?: string): void {
    this.push({ t: this.clock(), kind: "error", code, message: message.slice(0, 200) });
  }

  recordProvider(providerId: string): void {
    this.push({ t: this.clock(), kind: "provider", providerId });
  }

  recordLatency(name: string, ms: number): void {
    this.push({ t: this.clock(), kind: "latency", name, ms });
  }

  recordStaleDrops(drops: number): void {
    this.push({ t: this.clock(), kind: "stale", drops });
  }

  /** Mic frames (48 kHz internal). VAD level sampled at ≤10 Hz; PCM kept only when opted in. */
  recordMicFrame(frame: PCMFrame): void {
    const t = this.clock();
    if (t - this.lastVadAt >= 100) {
      this.lastVadAt = t;
      const level = Math.max(0, Math.min(1, (dbfs(rms(frame.data)) + 60) / 50));
      this.push({ t, kind: "vad", level });
    }
    if (this.micRing) for (const chunk of this.micConv.push(frame)) this.micRing.write(chunk);
  }

  /** Played assistant audio (speaker tap). Feeds the opt-in ring and the lip-delay probe. */
  recordAssistantFrame(frame: PCMFrame): void {
    if (this.assistantRing) for (const chunk of this.asstConv.push(frame)) this.assistantRing.write(chunk);
    const loud = rms(frame.data) > 0.02;
    if (loud) {
      const t = this.clock();
      this.lipLastAudioLoudAt = t;
      if (this.lipPending === null && !this.mouthWasOpen) this.lipPending = t;
    }
  }

  /**
   * Wraps an AvatarProvider so emotion / gesture / gaze / state calls are logged, without
   * changing behaviour. Prototype methods stay reachable (Proxy), so MotionStack-based providers
   * keep working through the wrapper.
   */
  wrapAvatar<T extends AvatarProvider>(provider: T): T {
    const rec = this;
    const intercept: Partial<Record<keyof AvatarProvider, (...args: never[]) => unknown>> = {
      setEmotion: (emotion: string, intensity: number) => {
        rec.push({ t: rec.clock(), kind: "emotion", emotion, intensity });
        return provider.setEmotion(emotion as never, intensity);
      },
      performGesture: (gesture: string, intensity: number) => {
        rec.push({ t: rec.clock(), kind: "gesture", gesture, intensity });
        return provider.performGesture(gesture as never, intensity);
      },
      setGaze: (target: { kind: string; x?: number; y?: number }) => {
        rec.push({ t: rec.clock(), kind: "gaze", target: `${target.kind}${target.x !== undefined ? ` x=${target.x.toFixed(2)}` : ""}${target.y !== undefined ? ` y=${target.y.toFixed(2)}` : ""}` });
        return provider.setGaze(target as never);
      },
    };
    return new Proxy(provider, {
      get(target, key, receiver) {
        const hit = intercept[key as keyof AvatarProvider];
        if (hit) return hit;
        const v = Reflect.get(target, key, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  /** Start the 10 Hz motion poll + rAF frame/lip probe against the (unwrapped) provider. */
  startProbe(provider: AvatarProvider): void {
    this.stopProbe();
    const stack = (provider as unknown as { stack?: { currentClip(layer: string): { id: string } | null } }).stack;
    const layers = ["idle", "speech", "gesture"];
    this.pollTimer = setInterval(() => {
      if (!stack) return;
      const t = this.clock();
      for (const layer of layers) {
        let id: string | null = null;
        try {
          id = stack.currentClip(layer)?.id ?? null;
        } catch {
          id = null;
        }
        if (this.lastClips[layer] !== id) {
          this.lastClips[layer] = id;
          this.push({ t, kind: "motion", layer, clip: id });
        }
      }
    }, 100);
    if (typeof requestAnimationFrame === "function" && provider.getParams) {
      const loop = () => {
        const t = this.clock();
        if (this.lastFrameAt) this.opts.observer?.noteFrameInterval(t - this.lastFrameAt);
        this.lastFrameAt = t;
        let p: AvatarParams | null = null;
        try {
          p = provider.getParams!();
        } catch {
          p = null;
        }
        if (p) {
          const open = p.mouthOpenY > 0.1;
          if (open && this.lipPending !== null) {
            this.opts.observer?.noteLipDelay(t - this.lipPending);
            this.lipPending = null;
          }
          if (!open && t - this.lipLastAudioLoudAt > 300) this.lipPending = null; // silence: reset probe
          this.mouthWasOpen = open;
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
  }

  stopProbe(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.raf !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  // ---- capture --------------------------------------------------------------
  capture(reason: string, note?: string): PresenceIncident {
    const at = this.clock();
    const half = this.windowMs / 2;
    const entries = this.entries.filter((e) => e.t >= at - half && e.t <= at + half).map((e) => ({ ...e, rel: Math.round(e.t - at) }));
    const incident: PresenceIncident = {
      id: `inc_${Date.now().toString(36)}_${(this.seq++).toString(36)}`,
      sessionId: this.opts.sessionId(),
      at: Date.now(),
      windowMs: this.windowMs,
      reason,
      note,
      provider: this.opts.getProvider?.() ?? null,
      avatarState: this.opts.getAvatarState?.() ?? "UNKNOWN",
      entries,
      hud: this.opts.getHud?.() ?? null,
      userOptIn: { ...this.optIn },
      mode: this.opts.meta?.mode,
      characterId: this.opts.meta?.characterId,
    };
    if (this.optIn.audio && this.micRing && this.assistantRing) {
      incident.micWavBase64 = int16ToWavBase64(this.micRing.read(), RING_RATE);
      incident.assistantWavBase64 = int16ToWavBase64(this.assistantRing.read(), RING_RATE);
    }
    if (this.optIn.video) {
      const jpeg = grabVideoFrame(this.opts.getVideoElement?.() ?? null);
      if (jpeg) incident.videoFrameJpegBase64 = jpeg;
    }
    this.incidents.push(incident);
    return incident;
  }

  /** Late-arriving entries (the +5 s half of the window) can be merged with this. */
  complete(incident: PresenceIncident): PresenceIncident {
    const capturedAtRel = this.clock() - (this.entries.length ? this.entries[this.entries.length - 1]!.t : this.clock());
    void capturedAtRel;
    const idx = this.incidents.indexOf(incident);
    const at = incident.entries.length ? incident.entries[incident.entries.length - 1]!.t : null;
    if (at === null) return incident;
    const half = this.windowMs / 2;
    const anchor = incident.entries.find((e) => e.rel === 0)?.t ?? at - incident.entries[incident.entries.length - 1]!.rel;
    const more = this.entries.filter((e) => e.t > at && e.t <= anchor + half).map((e) => ({ ...e, rel: Math.round(e.t - anchor) }));
    const merged = { ...incident, entries: [...incident.entries, ...more] };
    if (idx >= 0) this.incidents[idx] = merged;
    return merged;
  }

  snapshot(): IncidentEntry[] {
    return [...this.entries];
  }

  dispose(): void {
    this.stopProbe();
    this.micRing = null;
    this.assistantRing = null;
  }

  private push(e: IncidentEntry): void {
    this.entries.push(e);
    const cutoff = e.t - this.keepMs;
    if (this.entries.length > 4000 || (this.entries.length > 0 && this.entries[0]!.t < cutoff)) {
      let i = 0;
      while (i < this.entries.length && this.entries[i]!.t < cutoff) i++;
      if (i > 0) this.entries.splice(0, i);
      if (this.entries.length > 4000) this.entries.splice(0, this.entries.length - 4000);
    }
  }
}

class Int16Ring {
  private buf: Int16Array;
  private pos = 0;
  private filled = 0;
  constructor(size: number) {
    this.buf = new Int16Array(size);
  }
  write(chunk: Int16Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.pos] = chunk[i]!;
      this.pos = (this.pos + 1) % this.buf.length;
      if (this.filled < this.buf.length) this.filled++;
    }
  }
  read(): Int16Array {
    const out = new Int16Array(this.filled);
    const start = this.filled < this.buf.length ? 0 : this.pos;
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(start + i) % this.buf.length]!;
    return out;
  }
}

export function int16ToWavBase64(samples: Int16Array, sampleRate: number): string {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const dataLen = samples.length * 2;
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, dataLen, true);
  const bytes = new Uint8Array(44 + dataLen);
  bytes.set(new Uint8Array(header), 0);
  bytes.set(new Uint8Array(samples.buffer, samples.byteOffset, dataLen), 44);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function grabVideoFrame(video: HTMLVideoElement | null): string | null {
  if (!video || typeof document === "undefined" || video.readyState < 2) return null;
  try {
    const c = document.createElement("canvas");
    c.width = Math.min(320, video.videoWidth || 320);
    c.height = Math.round(c.width * ((video.videoHeight || 240) / (video.videoWidth || 320)));
    c.getContext("2d")?.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7).split(",")[1] ?? null;
  } catch {
    return null;
  }
}

// ---- persistence ------------------------------------------------------------------------------

const KEY = "rcai.incidents.v1";

/** Metadata only (no audio/video) so localStorage never holds media. */
export function loadIncidentMeta(storage: Pick<Storage, "getItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): PresenceIncident[] {
  try {
    const raw = storage?.getItem(KEY);
    return raw ? (JSON.parse(raw) as PresenceIncident[]) : [];
  } catch {
    return [];
  }
}

export function saveIncidentMeta(list: PresenceIncident[], storage: Pick<Storage, "setItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  try {
    const meta = list.slice(-50).map(({ micWavBase64: _a, assistantWavBase64: _b, videoFrameJpegBase64: _c, ...rest }) => rest);
    storage?.setItem(KEY, JSON.stringify(meta));
  } catch {
    /* quota */
  }
}

export function clearIncidentMeta(storage: Pick<Storage, "removeItem"> | null = typeof localStorage !== "undefined" ? localStorage : null): void {
  try {
    storage?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** POST to the broker unless strict_local (then the incident stays in the browser: copy/download). */
export async function submitIncident(brokerUrl: string, privacyMode: string, incident: PresenceIncident, fetchImpl: typeof fetch = fetch): Promise<"sent" | "local-only" | "failed"> {
  if (privacyMode === "strict_local") return "local-only";
  try {
    const res = await fetchImpl(`${brokerUrl.replace(/\/$/, "")}/api/incidents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(incident) });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
