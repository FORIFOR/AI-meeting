// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrame } from "@rcai/audio-core";
import type { CharacterDefinition } from "@rcai/avatar-core";
import type { AnamEvent, EventCallbacks } from "@anam-ai/js-sdk";
import { AnamAvatarProvider, type AnamAvatarOptions, type AnamAudioInputLike, type AnamClientLike } from "./AnamAvatarProvider.js";

const character: CharacterDefinition = {
  manifest: { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "gentle", voiceProfiles: [] },
  baseUrl: "/characters/yui", model: "model/yui.model3.json", expressions: {}, motions: {}, voice: { characterId: "yui", voices: {} },
};

class Track extends EventTarget {
  readyState = "live";
  enabled = true;
  stop = vi.fn(() => { this.readyState = "ended"; });
  constructor(readonly id: string, readonly kind: "audio" | "video") { super(); }
}
class Stream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === "video"); }
}
const media = (...tracks: Track[]) => new Stream(tracks as unknown as MediaStreamTrack[]) as unknown as MediaStream;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
class Client implements AnamClientLike {
  audio = new Track("audio", "audio");
  video = new Track("video", "video");
  chunks: Uint8Array[] = [];
  end = vi.fn();
  input: AnamAudioInputLike = {
    sendAudioChunk: (data) => { this.chunks.push(new Uint8Array(data as Uint8Array)); },
    endSequence: this.end,
  };
  handlers = new Map<AnamEvent, Set<(...args: never[]) => void>>();
  stream = vi.fn(async () => [media(this.audio), media(this.video), media(this.video, this.audio)]);
  createAgentAudioInputStream = vi.fn(() => this.input);
  interruptPersona = vi.fn();
  stopStreaming = vi.fn(async () => {});
  addListener<K extends AnamEvent>(name: K, fn: EventCallbacks[K]): void {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(fn as (...args: never[]) => void);
    this.handlers.set(name, handlers);
  }
  removeListener<K extends AnamEvent>(name: K, fn: EventCallbacks[K]): void {
    this.handlers.get(name)?.delete(fn as (...args: never[]) => void);
  }
  emit(name: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(name as AnamEvent) ?? []) handler(...args as never[]);
  }
}

const active: AnamAvatarProvider[] = [];
function setup(overrides: Partial<AnamAvatarOptions> = {}) {
  const client = new Client();
  const container = document.createElement("div");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sessionToken: "test-token" })));
  const factory = vi.fn(() => client);
  const provider = new AnamAvatarProvider({ container, brokerUrl: "https://broker.example/", fetch: fetchMock as unknown as typeof fetch, clientFactory: factory, ...overrides });
  active.push(provider);
  return { provider, client, container, fetchMock, factory };
}
async function ready() {
  const test = setup();
  await test.provider.prepare(character);
  await test.provider.start();
  return test;
}
function bytes(chunks: Uint8Array[]): number[] { return chunks.flatMap((chunk) => Array.from(chunk)); }

beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "readyState", "get").mockReturnValue(2);
});
afterEach(async () => {
  for (const provider of active.splice(0)) await provider.stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AnamAvatarProvider", () => {
  it("forbids all cloud work in strict_local mode", async () => {
    const { provider, fetchMock, factory } = setup({ privacyMode: "strict_local" });
    await expect(provider.prepare(character)).rejects.toThrow("ANAM_REQUIRES_CLOUD");
    await expect(provider.start()).rejects.toThrow("ANAM_PREPARE_REQUIRED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it("keeps the original character identity; broker owns avatar IDs and credentials", async () => {
    const { provider, fetchMock, factory } = setup();
    await provider.prepare(character);
    expect(provider.synchronizedAudio).toBeUndefined();
    const [url, request] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://broker.example/api/avatar/anam/session");
    expect(JSON.parse(String(request.body))).toEqual({ characterId: "yui", privacyMode: "default" });
    expect(character.model).toBe("model/yui.model3.json");
    await provider.start();
    expect(factory).toHaveBeenCalledWith("test-token", { disableInputAudio: true });
  });

  it("deduplicates unordered AV tracks, keeps only the output owner audible, and releases media", async () => {
    const { provider, client, container } = await ready();
    expect(provider.synchronizedAudio!.getOutputStream()!.getTracks()).toEqual([client.audio, client.video]);
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(video.defaultMuted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(container.querySelector("audio")).toBeNull();
    expect(client.audio.enabled).toBe(true);
    await provider.stop();
    await provider.stop();
    expect(client.stopStreaming).toHaveBeenCalledOnce();
    expect(client.audio.stop).toHaveBeenCalledOnce();
    expect(client.video.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(container.childElementCount).toBe(0);
    expect([...client.handlers.values()].every((set) => set.size === 0)).toBe(true);
  });

  it("retires ready media and notifies the fallback owner when video playback fails with live tracks", async () => {
    const { provider, client, container } = await ready();
    const source = provider.synchronizedAudio!;
    const failure = vi.fn();
    source.onFailure(failure);
    const video = container.querySelector("video")!;
    expect(client.audio.readyState).toBe("live");
    expect(client.video.readyState).toBe("live");

    video.dispatchEvent(new Event("error"));
    await Promise.resolve();

    expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "ANAM_VIDEO_FAILED" }));
    expect(provider.synchronizedAudio).toBeUndefined();
    expect(source.getOutputStream()).toBeNull();
    expect(client.audio.stop).toHaveBeenCalledOnce();
    expect(client.video.stop).toHaveBeenCalledOnce();
    expect(client.stopStreaming).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(container.childElementCount).toBe(0);
    source.pushSourceAudio(createFrame(new Float32Array(960).fill(0.4)));
    expect(client.chunks).toHaveLength(0);
    video.dispatchEvent(new Event("error"));
    expect(failure).toHaveBeenCalledOnce();
  });

  it("removes the lifetime video error listener when stopped and ignores detached media errors", async () => {
    const { provider, client, container } = await ready();
    const failure = vi.fn();
    provider.synchronizedAudio!.onFailure(failure);
    const video = container.querySelector("video")!;
    const remove = vi.spyOn(video, "removeEventListener");

    await provider.stop();
    expect(remove).toHaveBeenCalledWith("error", expect.any(Function));
    video.dispatchEvent(new Event("error"));

    expect(failure).not.toHaveBeenCalled();
    expect(client.stopStreaming).toHaveBeenCalledOnce();
    expect(provider.synchronizedAudio).toBeUndefined();
  });

  it("never feeds the speaker tap back upstream; flushes an incomplete turn exactly once", async () => {
    const { provider, client } = await ready();
    const source = provider.synchronizedAudio!;
    provider.pushAudio(createFrame(new Float32Array(960).fill(0.4)));
    expect(client.chunks).toHaveLength(0);
    source.pushSourceAudio(createFrame(new Float32Array(325).fill(0.5), 16_000));
    expect(client.chunks.map((chunk) => chunk.byteLength)).toEqual([640]);
    provider.setState("IDLE"); // State changes must not prematurely terminate source audio.
    expect(client.end).not.toHaveBeenCalled();
    source.endSourceTurn();
    source.endSourceTurn();
    expect(client.chunks.map((chunk) => chunk.byteLength)).toEqual([640, 10]);
    expect(client.end).toHaveBeenCalledOnce();
    expect(client.createAgentAudioInputStream).toHaveBeenCalledWith({ encoding: "pcm_s16le", sampleRate: 16_000, channels: 1 });
  });

  it("preserves the resampling phase across arbitrarily split 24 kHz chunks", async () => {
    const whole = await ready();
    const split = await ready();
    const wave = Float32Array.from({ length: 1500 }, (_, i) => Math.sin(i * Math.PI / 24) * 0.4);
    whole.provider.synchronizedAudio!.pushSourceAudio(createFrame(wave, 24_000));
    whole.provider.synchronizedAudio!.endSourceTurn();
    for (const [start, end] of [[0, 101], [101, 318], [318, 851], [851, 1500]]) {
      split.provider.synchronizedAudio!.pushSourceAudio(createFrame(wave.slice(start, end), 24_000));
    }
    split.provider.synchronizedAudio!.endSourceTurn();
    expect(bytes(split.client.chunks)).toEqual(bytes(whole.client.chunks));
    expect(bytes(split.client.chunks).length).toBe(2000);
  });

  it("discards interrupted remainder and prevents old AV or later PCM from reappearing", async () => {
    const { provider, client } = await ready();
    const source = provider.synchronizedAudio!;
    const failed = vi.fn();
    source.onFailure(failed);
    source.pushSourceAudio(createFrame(new Float32Array(10).fill(0.8), 16_000));
    provider.interrupt();
    provider.interrupt();
    source.endSourceTurn();
    source.pushSourceAudio(createFrame(new Float32Array(640).fill(0.8), 16_000));
    expect(client.chunks).toHaveLength(0);
    expect(client.interruptPersona).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(source.getOutputStream()).toBeNull();
    expect(client.audio.readyState).toBe("ended");
  });

  it("cleans media and notifies failure once without forwarding SDK error details", async () => {
    const { provider, client, container } = await ready();
    const failed = vi.fn();
    provider.synchronizedAudio!.onFailure(failed);
    client.emit("CONNECTION_CLOSED", "error", "secret-token from vendor");
    client.emit("CONNECTION_CLOSED", "error");
    expect(failed).toHaveBeenCalledOnce();
    expect(failed.mock.calls[0]![0].message).toBe("ANAM_CONNECTION_CLOSED");
    expect(container.childElementCount).toBe(0);
    expect(client.audio.stop).toHaveBeenCalledOnce();
  });

  it("bounds startup and disposes media that resolves after the deadline", async () => {
    vi.useFakeTimers();
    const { provider, client, container } = setup({ startupTimeoutMs: 40 });
    const pending = deferred<MediaStream[]>();
    client.stream.mockImplementation(() => pending.promise);
    await provider.prepare(character);
    const starting = expect(provider.start()).rejects.toThrow("ANAM_STARTUP_TIMEOUT");
    await vi.advanceTimersByTimeAsync(40);
    await starting;
    expect(client.stopStreaming).toHaveBeenCalledOnce();
    const lateTrack = new Track("late", "audio");
    pending.resolve([media(lateTrack)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(lateTrack.stop).toHaveBeenCalledOnce();
    expect(client.stopStreaming).toHaveBeenCalledTimes(2);
    expect(container.childElementCount).toBe(0);
    expect(provider.synchronizedAudio).toBeUndefined();
  });

  it("stops a client factory that finishes after stop without opening its stream", async () => {
    const pending = deferred<AnamClientLike>();
    const { provider } = setup({ clientFactory: () => pending.promise });
    await provider.prepare(character);
    const starting = expect(provider.start()).rejects.toThrow("ANAM_CANCELLED");
    await provider.stop();
    await starting;
    const late = new Client();
    pending.resolve(late);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.stopStreaming).toHaveBeenCalledOnce();
    expect(late.stream).not.toHaveBeenCalled();
  });

  it("aborts stale token preparation and never reuses its late token", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn(() => pending.promise);
    const { provider, factory } = setup({ fetch: fetchMock as unknown as typeof fetch });
    const preparing = expect(provider.prepare(character)).rejects.toThrow("ANAM_CANCELLED");
    const request = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    await provider.stop();
    await preparing;
    expect(request[1].signal!.aborted).toBe(true);
    pending.resolve(new Response(JSON.stringify({ sessionToken: "late-token" })));
    await Promise.resolve();
    await expect(provider.start()).rejects.toThrow("ANAM_PREPARE_REQUIRED");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not declare output ready before video playback can start", async () => {
    vi.useFakeTimers();
    const pending = deferred<void>();
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementation(() => pending.promise);
    const { provider, container } = setup({ startupTimeoutMs: 40 });
    await provider.prepare(character);
    const starting = expect(provider.start()).rejects.toThrow("ANAM_STARTUP_TIMEOUT");
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector("video")).not.toBeNull();
    expect(provider.synchronizedAudio).toBeUndefined();
    await vi.advanceTimersByTimeAsync(40);
    await starting;
    expect(container.childElementCount).toBe(0);
    pending.resolve();
  });

  it("rejects video-only output instead of silently losing the voice", async () => {
    const { provider, client } = setup();
    client.stream.mockResolvedValue([media(client.video)]);
    await provider.prepare(character);
    await expect(provider.start()).rejects.toThrow("ANAM_MEDIA_TRACKS_MISSING");
    expect(client.video.stop).toHaveBeenCalledOnce();
    expect(provider.synchronizedAudio).toBeUndefined();
  });

  it("does not let an old source handle submit PCM into a replacement session", async () => {
    const first = new Client();
    const second = new Client();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { provider } = setup({ clientFactory: factory });
    await provider.prepare(character);
    await provider.start();
    const oldSource = provider.synchronizedAudio!;
    await provider.prepare(character);
    await provider.start();
    oldSource.pushSourceAudio(createFrame(new Float32Array(640).fill(0.4), 16_000));
    oldSource.endSourceTurn();
    expect(oldSource.getOutputStream()).toBeNull();
    expect(second.chunks).toHaveLength(0);
    provider.synchronizedAudio!.pushSourceAudio(createFrame(new Float32Array(320).fill(0.1), 16_000));
    expect(second.chunks).toHaveLength(1);
  });

  it("bounds a hung SDK stop while removing local tracks and video immediately", async () => {
    vi.useFakeTimers();
    const { provider, client, container } = await ready();
    client.stopStreaming.mockImplementation(() => new Promise(() => {}));
    const stopped = provider.stop();
    expect(container.childElementCount).toBe(0);
    expect(client.audio.readyState).toBe("ended");
    await vi.advanceTimersByTimeAsync(1_500);
    await stopped;
    expect(provider.synchronizedAudio).toBeUndefined();
  });
});
