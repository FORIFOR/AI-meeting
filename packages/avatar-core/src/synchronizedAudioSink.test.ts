// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioTap, createFrame, createPcmTapNode, type AudioSink, type PcmTapNode } from "@rcai/audio-core";
import { SYNCHRONIZED_CAPTURE_TIMEOUT_MS, SynchronizedAvatarSink } from "./synchronizedAudioSink.js";
import { DualRenderer } from "./dualRenderer.js";
import type { AvatarProvider, SynchronizedAvatarAudio } from "./types.js";

vi.mock("@rcai/audio-core", async (original) => ({
  ...await original<typeof import("@rcai/audio-core")>(),
  createPcmTapNode: vi.fn(),
}));

function stream() {
  const track = { stop: vi.fn(), readyState: "live" };
  return { stream: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream, track };
}

function harness(external = true) {
  const order: string[] = [];
  let failure: ((error: Error) => void) | null = null;
  const output = stream();
  const audio = {
    pushSourceAudio: vi.fn(), endSourceTurn: vi.fn(), getOutputStream: vi.fn(() => output.stream),
    onFailure: vi.fn((listener: (error: Error) => void) => {
      failure = listener;
      return vi.fn(() => { failure = null; });
    }),
  } satisfies SynchronizedAvatarAudio;
  const avatar = {
    id: "dual-renderer", synchronizedAudio: external ? audio : undefined,
    interrupt: vi.fn(() => { order.push("avatar-interrupt"); }),
    useLocalFallback: vi.fn(() => { order.push("fallback"); }),
  } as unknown as AvatarProvider;
  const sink = {
    tap: new AudioTap(), isPlaying: true, play: vi.fn(() => true),
    attachStream: vi.fn((s: MediaStream) => { order.push(s === output.stream ? "attach-return" : "attach-source"); }),
    detachStream: vi.fn(() => { order.push("detach"); }),
    interrupt: vi.fn(() => { order.push("mute"); return 0.25; }),
    resumeStream: vi.fn(), endTurn: vi.fn(), close: vi.fn(),
  } satisfies AudioSink & { close: () => void };
  const wrapper = new SynchronizedAvatarSink({ sink, avatar: () => avatar });
  return { wrapper, sink, avatar, audio, output, order, fail: () => failure?.(new Error("test-failure")), failure: () => failure };
}

function tap() {
  let listener: ((data: Float32Array) => void) | null = null;
  const instance = {
    node: { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioWorkletNode,
    disposed: false as boolean,
    onChunk: vi.fn((next: (data: Float32Array) => void) => {
      listener = next;
      return () => { listener = null; };
    }),
    dispose: vi.fn(() => { instance.disposed = true; listener = null; }),
  } satisfies PcmTapNode;
  return { instance, emit: (data = new Float32Array([0.2, 0.3])) => listener?.(data), listener: () => listener };
}

const contexts: ReturnType<typeof context>[] = [];
function context() {
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const source = node();
  const mute = { ...node(), gain: { value: 1 } };
  const ctx = {
    state: "running", sampleRate: 48_000, destination: {},
    createMediaStreamSource: vi.fn(() => source), createGain: vi.fn(() => mute),
    resume: vi.fn(async () => {}), close: vi.fn(async () => { ctx.state = "closed"; }),
  };
  return { ctx, source, mute };
}

const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  contexts.length = 0;
  vi.mocked(createPcmTapNode).mockReset();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("AudioContext", function () {
    const next = context(); contexts.push(next); return next.ctx;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("SynchronizedAvatarSink PCM", () => {
  it("sends original PCM exactly once and plays only the returned stream with the original downstream tap", () => {
    const h = harness();
    const frame = createFrame(new Float32Array([0.3]));
    const observed = vi.fn();
    h.wrapper.tap.subscribe(observed);
    h.wrapper.resumeStream();
    h.wrapper.play(frame, { generationId: 1 });
    h.wrapper.play(frame, { generationId: 1 });
    expect(h.audio.pushSourceAudio.mock.calls).toEqual([[frame], [frame]]);
    expect(h.sink.play).not.toHaveBeenCalled();
    expect(h.sink.attachStream).toHaveBeenCalledExactlyOnceWith(h.output.stream);
    expect(h.wrapper.tap).toBe(h.sink.tap);
    expect(h.sink.tap.size).toBe(1);
    h.sink.tap.push(frame);
    expect(observed).toHaveBeenCalledWith(frame);
    expect(h.audio.pushSourceAudio).toHaveBeenCalledTimes(2);
    const mutings = h.sink.interrupt.mock.calls.length;
    h.wrapper.endTurn();
    h.wrapper.endTurn();
    expect(h.audio.endSourceTurn).toHaveBeenCalledOnce();
    expect(h.sink.interrupt).toHaveBeenCalledTimes(mutings);
    expect(h.sink.detachStream).not.toHaveBeenCalled();
    expect(h.wrapper.isPlaying).toBe(true);
    h.wrapper.dispose();
  });

  it("preserves ordinary sink behavior when the avatar is local", () => {
    const h = harness(false);
    const source = stream().stream;
    const frame = createFrame(new Float32Array([0.1]));
    h.wrapper.attachStream(source);
    h.wrapper.resumeStream();
    expect(h.wrapper.play(frame, { generationId: 2 })).toBe(true);
    expect(h.sink.play).toHaveBeenCalledWith(frame, { generationId: 2 });
    expect(h.sink.attachStream).toHaveBeenCalledExactlyOnceWith(source);
    h.wrapper.endTurn();
    expect(h.sink.endTurn).toHaveBeenCalledOnce();
    expect(h.wrapper.clearQueue(3)).toBe(0.25);
    expect(h.sink.interrupt).toHaveBeenCalledWith(3);
    expect(h.avatar.interrupt).not.toHaveBeenCalled();
    h.wrapper.detachStream();
    expect(h.sink.detachStream).toHaveBeenCalledOnce();
    h.wrapper.dispose();
    expect(h.sink.close).not.toHaveBeenCalled();
  });

  it("mutes synchronously before interrupt/fallback, rejects stale frames, and never reuses a cancelled renderer", () => {
    const h = harness();
    const frame = createFrame(new Float32Array([0.1]));
    h.wrapper.play(frame, { generationId: 1 });
    h.order.length = 0;
    h.wrapper.interrupt(2);
    expect(h.order).toEqual(["mute", "detach", "avatar-interrupt", "fallback"]);
    expect(h.wrapper.play(frame, { generationId: 1 })).toBe(false);
    expect(h.wrapper.staleFramesDropped).toBe(1);
    h.wrapper.resumeStream();
    h.wrapper.play(frame, { generationId: 2 });
    expect(h.sink.play).toHaveBeenCalledExactlyOnceWith(frame, { generationId: 2 });
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(h.audio.onFailure).toHaveBeenCalledOnce();
    h.wrapper.dispose();
  });

  it("does not replay a partially sent frame after send failure; only future source frames go local", () => {
    const h = harness();
    h.audio.pushSourceAudio.mockImplementationOnce(() => { throw new Error("partial send"); });
    const first = createFrame(new Float32Array([0.1]));
    const second = createFrame(new Float32Array([0.2]));
    h.wrapper.play(first);
    expect(h.avatar.useLocalFallback).toHaveBeenCalledOnce();
    expect(h.sink.play).not.toHaveBeenCalled();
    h.wrapper.play(second);
    expect(h.sink.play).toHaveBeenCalledExactlyOnceWith(second, {});
    h.wrapper.dispose();
  });

  it("retires old returned AV on the next user turn even after source EOF, without reusing it", () => {
    const h = harness();
    const frame = createFrame(new Float32Array([0.1]));
    h.wrapper.resumeStream();
    h.wrapper.play(frame, { generationId: 1 });
    h.wrapper.endTurn();
    h.order.length = 0;
    expect(h.wrapper.beginUserTurn()).toBe(true);
    expect(h.order).toEqual(["mute", "detach", "avatar-interrupt", "fallback"]);
    expect(h.avatar.useLocalFallback).toHaveBeenCalledWith("ANAM_UNCONFIRMED_OUTPUT_REQUIRES_LOCAL_FALLBACK");
    expect(h.wrapper.beginUserTurn()).toBe(false);
    h.wrapper.interrupt(2); // The ordinary runtime cancellation can safely follow the boundary hook.
    h.wrapper.resumeStream();
    h.wrapper.play(frame, { generationId: 2 });
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(h.avatar.useLocalFallback).toHaveBeenCalledOnce();
    expect(h.sink.play).toHaveBeenCalledExactlyOnceWith(frame, { generationId: 2 });
    h.wrapper.dispose();
  });

  it("keeps an unused ready external binding through the first user turn", () => {
    const h = harness();
    h.wrapper.resumeStream();
    h.order.length = 0;
    expect(h.wrapper.beginUserTurn()).toBe(false);
    expect(h.order).toEqual([]);
    expect(h.avatar.useLocalFallback).not.toHaveBeenCalled();
    h.wrapper.play(createFrame(new Float32Array([0.1])));
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    h.wrapper.dispose();
  });

  it("leaves the local mouth usable when the dual renderer handles a network failure before the sink", async () => {
    const h = harness();
    const listeners = new Set<(error: Error) => void>();
    h.audio.onFailure.mockImplementation((listener) => {
      listeners.add(listener);
      return vi.fn(() => { listeners.delete(listener); });
    });
    let localSpeaking = true;
    const mouthFrames: unknown[] = [];
    const local = {
      id: "live2d", start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      interrupt: vi.fn(() => { localSpeaking = false; }),
      pushAudio: vi.fn((frame) => { if (localSpeaking) mouthFrames.push(frame); }),
    } as unknown as AvatarProvider;
    const natural = { ...h.avatar, start: vi.fn(async () => {}), stop: vi.fn(async () => {}) } as AvatarProvider;
    const dual = new DualRenderer({ local, natural, localContainer: document.createElement("div"), naturalContainer: document.createElement("div") });
    await dual.start(); // DualRenderer subscribes first, just as in the real session setup.
    const wrapper = new SynchronizedAvatarSink({ sink: h.sink, avatar: () => dual });
    wrapper.tap.subscribe((frame) => dual.pushAudio(frame));
    wrapper.play(createFrame(new Float32Array([0.1])));
    for (const listener of [...listeners]) listener(new Error("connection lost"));
    expect(dual.id).toBe("live2d");
    expect(local.interrupt).not.toHaveBeenCalled();
    expect(natural.interrupt).not.toHaveBeenCalled();
    expect(natural.stop).toHaveBeenCalledOnce();
    const next = createFrame(new Float32Array([0.2]));
    wrapper.play(next);
    h.sink.tap.push(next); // The ordinary speaker returns future audible PCM to the local renderer.
    expect(h.sink.play).toHaveBeenCalledExactlyOnceWith(next, {});
    expect(mouthFrames).toEqual([next]);
    wrapper.dispose();
    await dual.stop();
  });

  it.each([false, true])("stops a direct external provider when no local-switch owner exists (explicit interrupt=%s)", (explicit) => {
    const h = harness();
    delete h.avatar.useLocalFallback;
    h.avatar.stop = vi.fn(async () => {});
    h.wrapper.play(createFrame(new Float32Array([0.1])));
    if (explicit) h.wrapper.interrupt(); else h.fail();
    expect(h.avatar.stop).toHaveBeenCalledOnce();
    expect(h.avatar.interrupt).toHaveBeenCalledTimes(explicit ? 1 : 0);
    h.wrapper.dispose();
  });

  it("unsubscribes failure listeners and ignores a late callback after disposal", () => {
    const h = harness();
    h.wrapper.play(createFrame(new Float32Array([0.1])));
    const late = h.failure()!;
    h.wrapper.dispose();
    h.wrapper.dispose();
    expect(h.failure()).toBeNull();
    late(new Error("late callback"));
    expect(h.avatar.useLocalFallback).toHaveBeenCalledOnce();
    expect(h.wrapper.play(createFrame(new Float32Array([0.1])))).toBe(false);
    expect(h.sink.close).not.toHaveBeenCalled();
    expect(h.output.track.stop).not.toHaveBeenCalled();
    expect(document.querySelectorAll("audio")).toHaveLength(0);
  });
});

describe("SynchronizedAvatarSink MediaStream", () => {
  it.each(["worklet", "resume"])("falls back within eight seconds when capture %s never becomes ready", async (phase) => {
    vi.useFakeTimers();
    const h = harness();
    const source = stream();
    const captured = tap();
    let release!: () => void;
    if (phase === "worklet") {
      vi.mocked(createPcmTapNode).mockImplementation(() => new Promise((resolve) => { release = () => resolve(captured.instance); }));
    } else {
      const pendingContext = context();
      pendingContext.ctx.state = "suspended";
      pendingContext.ctx.resume.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
      vi.stubGlobal("AudioContext", function () { contexts.push(pendingContext); return pendingContext.ctx; });
      vi.mocked(createPcmTapNode).mockResolvedValue(captured.instance);
    }
    h.wrapper.attachStream(source.stream);
    h.wrapper.resumeStream();
    await settle();
    await vi.advanceTimersByTimeAsync(SYNCHRONIZED_CAPTURE_TIMEOUT_MS);
    expect(h.avatar.useLocalFallback).toHaveBeenCalledWith("ANAM_SOURCE_CAPTURE_TIMEOUT");
    expect(h.sink.attachStream).toHaveBeenLastCalledWith(source.stream);
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    release();
    await settle();
    expect(captured.instance.dispose).toHaveBeenCalledOnce();
    expect(h.sink.attachStream).toHaveBeenCalledTimes(2);
    expect(h.audio.pushSourceAudio).not.toHaveBeenCalled();
    h.wrapper.dispose();
  });

  it("captures source through an inaudible graph only while the source turn is open", async () => {
    const h = harness();
    const source = stream();
    const captured = tap();
    vi.mocked(createPcmTapNode).mockResolvedValue(captured.instance);
    h.wrapper.attachStream(source.stream);
    await settle();
    expect(h.sink.attachStream).toHaveBeenCalledExactlyOnceWith(h.output.stream);
    expect(contexts[0]!.ctx.createMediaStreamSource).toHaveBeenCalledWith(source.stream);
    expect(contexts[0]!.mute.gain.value).toBe(0);
    const elements = [...document.querySelectorAll("audio")];
    expect(elements).toHaveLength(2);
    expect(elements.every((element) => element.muted)).toBe(true);
    captured.emit();
    expect(h.audio.pushSourceAudio).not.toHaveBeenCalled();
    h.wrapper.resumeStream();
    captured.emit();
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(h.audio.pushSourceAudio.mock.calls[0]![0]).toMatchObject({ sampleRate: 48_000, channels: 1 });
    h.wrapper.endTurn();
    expect(h.audio.endSourceTurn).toHaveBeenCalledOnce();
    const mutings = h.sink.interrupt.mock.calls.length;
    captured.emit(new Float32Array(480));
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(h.sink.interrupt).toHaveBeenCalledTimes(mutings);
    h.wrapper.resumeStream();
    captured.emit();
    expect(h.audio.pushSourceAudio).toHaveBeenCalledTimes(2);
    h.wrapper.dispose();
    expect(captured.instance.dispose).toHaveBeenCalledOnce();
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(source.track.stop).not.toHaveBeenCalled();
    expect(h.output.track.stop).not.toHaveBeenCalled();
  });

  it("drops late captured chunks after interruption and restores the original source only on next resume", async () => {
    const h = harness();
    const source = stream();
    const captured = tap();
    vi.mocked(createPcmTapNode).mockResolvedValue(captured.instance);
    h.wrapper.attachStream(source.stream);
    h.wrapper.resumeStream();
    await settle();
    captured.emit();
    const late = captured.listener()!;
    h.order.length = 0;
    h.wrapper.interrupt(2);
    expect(h.order).toEqual(["mute", "detach", "avatar-interrupt", "fallback"]);
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    late(new Float32Array([0.5]));
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(h.sink.attachStream).toHaveBeenCalledTimes(1);
    h.wrapper.resumeStream();
    expect(h.sink.attachStream).toHaveBeenLastCalledWith(source.stream);
    expect(h.sink.attachStream).toHaveBeenCalledTimes(2);
    expect(createPcmTapNode).toHaveBeenCalledOnce();
    expect(h.sink.play).not.toHaveBeenCalled();
    h.wrapper.dispose();
  });

  it("switches future source stream audio to local playback after an active renderer failure", async () => {
    const h = harness();
    const source = stream();
    vi.mocked(createPcmTapNode).mockResolvedValue(tap().instance);
    h.wrapper.attachStream(source.stream);
    h.wrapper.resumeStream();
    await settle();
    h.order.length = 0;
    h.fail();
    expect(h.order).toEqual(["mute", "detach", "fallback", "attach-source"]);
    expect(h.sink.attachStream).toHaveBeenLastCalledWith(source.stream);
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(h.sink.play).not.toHaveBeenCalled();
    h.wrapper.dispose();
  });

  it("disposes a worklet that finishes loading after stop without resurrecting any media path", async () => {
    const h = harness();
    const source = stream();
    const captured = tap();
    let release!: (value: PcmTapNode) => void;
    vi.mocked(createPcmTapNode).mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    h.wrapper.attachStream(source.stream);
    h.wrapper.resumeStream();
    h.wrapper.dispose();
    release(captured.instance);
    await settle();
    expect(captured.instance.dispose).toHaveBeenCalledOnce();
    expect(captured.instance.onChunk).not.toHaveBeenCalled();
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("audio")).toHaveLength(0);
    expect(h.sink.attachStream).toHaveBeenCalledOnce();
    expect(source.track.stop).not.toHaveBeenCalled();
  });

  it("cleans a failed capture and restores the source stream without unhandled rejection", async () => {
    const h = harness();
    const source = stream();
    vi.mocked(createPcmTapNode).mockRejectedValue(new Error("unsupported worklet"));
    h.wrapper.attachStream(source.stream);
    h.wrapper.resumeStream();
    await settle();
    expect(h.avatar.useLocalFallback).toHaveBeenCalledWith("ANAM_SOURCE_CAPTURE_UNAVAILABLE");
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(h.sink.attachStream).toHaveBeenLastCalledWith(source.stream);
    expect(document.querySelectorAll("audio")).toHaveLength(0);
    h.wrapper.dispose();
  });

  it("releases a replaced source capture even when the old worklet finishes last", async () => {
    const h = harness();
    const oldTap = tap();
    const newTap = tap();
    const source1 = stream();
    const source2 = stream();
    let release!: (value: PcmTapNode) => void;
    vi.mocked(createPcmTapNode)
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
      .mockResolvedValueOnce(newTap.instance);
    h.wrapper.attachStream(source1.stream);
    h.wrapper.attachStream(source2.stream);
    h.wrapper.resumeStream();
    await settle();
    release(oldTap.instance);
    await settle();
    expect(oldTap.instance.dispose).toHaveBeenCalledOnce();
    expect(oldTap.instance.onChunk).not.toHaveBeenCalled();
    newTap.emit();
    expect(h.audio.pushSourceAudio).toHaveBeenCalledOnce();
    expect(contexts[0]!.ctx.close).toHaveBeenCalledOnce();
    expect(contexts[1]!.ctx.close).not.toHaveBeenCalled();
    expect(h.sink.attachStream).toHaveBeenCalledExactlyOnceWith(h.output.stream);
    h.wrapper.dispose();
  });
});
