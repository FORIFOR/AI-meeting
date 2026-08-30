// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPcmTapNode, ensurePcmTapWorklet, WorkletUnavailableError } from "./worklet.js";
import { SpeakerOutput } from "./speaker.js";
import { MicCapture } from "./mic.js";

/** Minimal AudioContext stand-in: enough surface for worklet/speaker/mic lifecycle paths. */
function fakeContext(opts: { addModule?: () => Promise<void> } = {}) {
  const calls = { addModule: 0, close: 0, disconnects: 0 };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(() => calls.disconnects++), gain: { cancelScheduledValues: vi.fn(), setValueAtTime: vi.fn() } });
  const ctx: Record<string, unknown> = {
    state: "running",
    sampleRate: 48000,
    currentTime: 0,
    destination: {},
    audioWorklet: {
      addModule: vi.fn(async () => {
        calls.addModule++;
        await (opts.addModule ?? (async () => {}))();
      }),
    },
    createGain: () => node(),
    createMediaStreamSource: () => node(),
    createBuffer: () => ({ copyToChannel: vi.fn(), duration: 0.01 }),
    createBufferSource: () => ({ ...node(), start: vi.fn(), stop: vi.fn(), buffer: null, onended: null }),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {
      calls.close++;
      ctx.state = "closed";
    }),
  };
  return { ctx: ctx as unknown as AudioContext, calls };
}

class FakeWorkletNode {
  port = { onmessage: null as unknown, postMessage: vi.fn(), close: vi.fn() };
  connect = vi.fn();
  disconnect = vi.fn();
  constructor(public ctx: unknown, public name: string) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensurePcmTapWorklet", () => {
  it("registers once per context and shares the in-flight promise between concurrent callers", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    let release!: () => void;
    const { ctx, calls } = fakeContext({ addModule: () => new Promise<void>((r) => (release = r)) });
    const p1 = ensurePcmTapWorklet(ctx);
    const p2 = ensurePcmTapWorklet(ctx);
    expect(p1).toBe(p2);
    release();
    await p1;
    await ensurePcmTapWorklet(ctx);
    expect(calls.addModule).toBe(1);
  });

  it("rejects with WorkletUnavailableError('closed') when the context closes mid-load, without unhandled rejections", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const { ctx } = fakeContext({
      addModule: async () => {
        (ctx as unknown as { state: string }).state = "closed";
        throw Object.assign(new Error("Unable to load a worklet's module."), { name: "AbortError" });
      },
    });
    const p = ensurePcmTapWorklet(ctx);
    await expect(p).rejects.toBeInstanceOf(WorkletUnavailableError);
    await expect(p).rejects.toMatchObject({ reason: "closed" });
    // Not awaiting a second call must not create an unhandled rejection either.
    ensurePcmTapWorklet(ctx);
    await new Promise((r) => setTimeout(r, 10));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("refuses to create a node on a closed context", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { ctx } = fakeContext();
    (ctx as unknown as { state: string }).state = "closed";
    await expect(createPcmTapNode(ctx)).rejects.toMatchObject({ reason: "closed" });
  });

  it("tap dispose is idempotent and closes the processor port", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { ctx } = fakeContext();
    const tap = await createPcmTapNode(ctx, 10);
    const node = tap.node as unknown as FakeWorkletNode;
    tap.dispose();
    tap.dispose();
    expect(tap.disposed).toBe(true);
    expect(node.port.postMessage).toHaveBeenCalledTimes(1);
    expect(node.port.postMessage).toHaveBeenCalledWith("close");
    expect(node.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("SpeakerOutput / MicCapture lifecycle", () => {
  it("close() during worklet load (StrictMode double-mount) releases the tap and never rejects", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    vi.stubGlobal("performance", { now: () => 0 });
    let release!: () => void;
    const { ctx, calls } = fakeContext({ addModule: () => new Promise<void>((r) => (release = r)) });
    const sp = new SpeakerOutput({ context: ctx });
    const closing = sp.close();
    release();
    await closing;
    await expect(sp.whenReady()).resolves.toBeUndefined();
    expect(sp.isClosed).toBe(true);
    expect(calls.close).toBe(0); // externally provided context is not closed by the speaker
    await sp.close(); // idempotent
  });

  it("owned context is closed exactly once by the speaker; mic never closes a shared context", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    vi.stubGlobal("performance", { now: () => 0 });
    const { ctx, calls } = fakeContext();
    vi.stubGlobal("AudioContext", function () {
      return ctx;
    });
    const sp = new SpeakerOutput();
    await sp.whenReady();
    const track = { stop: vi.fn(), enabled: true, readyState: "live" };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track], getAudioTracks: () => [track] })) } });
    const mic = new MicCapture({ context: sp.context });
    await mic.start();
    await mic.stop();
    await mic.stop();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(calls.close).toBe(0);
    await sp.close();
    await sp.close();
    expect(calls.close).toBe(1);
  });

  it("mic stop() while start() is in flight stops the tracks it obtained", async () => {
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: vi.fn() });
    vi.stubGlobal("Blob", class {});
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
    const { ctx } = fakeContext();
    const track = { stop: vi.fn(), enabled: true, readyState: "live" };
    let grant!: (s: unknown) => void;
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => new Promise((r) => (grant = r))) } });
    const mic = new MicCapture({ context: ctx });
    const starting = mic.start();
    await mic.stop();
    grant({ getTracks: () => [track], getAudioTracks: () => [track] });
    await expect(starting).rejects.toThrow(/stopped/);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(mic.mediaStream).toBeNull();
  });
});
