import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PCMFrame } from "@rcai/audio-core";
import type { LipSyncOutput } from "@rcai/avatar-core";
import { WLipSyncEngine } from "./WLipSyncEngine.js";
import { WLipSyncCore } from "./wlipsyncCore.js";
import type { LipSyncWorker, LipSyncWorkerInput, LipSyncWorkerOutput } from "./wlipsyncProtocol.js";

const frame = (value = 0.2, length = 960): PCMFrame => ({
  data: new Float32Array(length).fill(value), sampleRate: 48000, channels: 1, timestamp: 1,
});
const output = (): LipSyncOutput => ({ mouthOpenY: 0.8, mouthForm: 0,
  visemes: { a: 0.8, i: 0, u: 0, e: 0, o: 0, silence: 0.2 }, levelDb: -20 });

class FakeWorker implements LipSyncWorker {
  onmessage: LipSyncWorker["onmessage"] = null;
  onerror: LipSyncWorker["onerror"] = null;
  messages: LipSyncWorkerInput[] = [];
  postMessage = vi.fn((message: LipSyncWorkerInput) => { this.messages.push(message); });
  terminate = vi.fn();
  send(message: LipSyncWorkerOutput): void { this.onmessage?.({ data: message } as MessageEvent<LipSyncWorkerOutput>); }
  audio(index = -1): Extract<LipSyncWorkerInput, { type: "audio" }> {
    return this.messages.filter((message) => message.type === "audio").at(index)!;
  }
  result(job = this.audio(), name = "I"): void {
    this.send({ type: "result", generation: job.generation, sequence: job.sequence, at: job.at, name, volume: 0.2 });
  }
}

afterEach(() => vi.useRealTimers());

describe("wLipSync analysis observer", () => {
  function setup() {
    const worker = new FakeWorker();
    let now = 100;
    const fallback = { push: vi.fn(), sample: vi.fn(() => output()), reset: vi.fn() };
    const engine = new WLipSyncEngine({ clock: () => now, fallback, createWorker: () => worker });
    return { engine, worker, fallback, advance: (ms: number) => { now += ms; } };
  }

  it("continues synchronous analysis during slow WASM startup, without replaying earlier PCM", () => {
    const { engine, worker, fallback } = setup();
    engine.start();
    engine.push(frame());
    expect(fallback.push).toHaveBeenCalledOnce();
    expect(engine.sample().mouthOpenY).toBe(0.8);
    expect(worker.messages).toHaveLength(0);
    worker.send({ type: "ready" });
    expect(worker.messages).toHaveLength(0);
    const pcm = frame();
    engine.push(pcm);
    expect(worker.audio().data).not.toBe(pcm.data); // The speaker's buffer is never transferred/detached.
    worker.result();
    expect(engine.sample().visemes.i).toBeGreaterThan(0);
    expect(engine.getDiagnostics().actual).toBe("wlipsync");
    engine.dispose();
  });

  it("bounds worker backlog to one in-flight and one latest job", () => {
    const { engine, worker } = setup();
    engine.start(); worker.send({ type: "ready" });
    for (let index = 0; index < 100; index++) engine.push(frame(index / 100));
    expect(worker.messages).toHaveLength(1);
    worker.result();
    expect(worker.messages).toHaveLength(2);
    expect(worker.audio().sequence).toBe(100);
    expect(worker.audio().data[0]).toBeCloseTo(0.99);
    engine.dispose();
  });

  it("rejects cancelled asynchronous results and allows the next real generation", () => {
    const { engine, worker } = setup();
    engine.start(); worker.send({ type: "ready" });
    engine.push(frame());
    const cancelled = worker.audio();
    engine.reset();
    expect(engine.sample().mouthOpenY).toBe(0);
    engine.push(frame()); // Queued until the old in-flight request acknowledges.
    worker.result(cancelled);
    expect(engine.getDiagnostics().actual).toBe("analyzer");
    const current = worker.audio();
    expect(current.generation).not.toBe(cancelled.generation);
    worker.result(current, "O");
    expect(engine.sample().visemes.o).toBeGreaterThan(0);
    worker.result(cancelled, "I");
    expect(engine.sample().visemes.i).toBe(0);
    engine.dispose();
  });

  it("closes for silence and stopped speaker taps even if an old result arrives later", () => {
    const { engine, worker, fallback, advance } = setup();
    engine.start(); worker.send({ type: "ready" }); engine.push(frame()); worker.result();
    expect(engine.sample().mouthOpenY).toBeGreaterThan(0);
    fallback.sample.mockReturnValue({ ...output(), levelDb: -80 });
    engine.push(frame(0)); worker.result();
    expect(engine.sample().visemes).toEqual({ a: 0, i: 0, u: 0, e: 0, o: 0, silence: 1 });
    fallback.sample.mockReturnValue(output());
    advance(101);
    expect(engine.sample().mouthOpenY).toBe(0);
    engine.dispose();
  });

  it("discards stale analysis and falls back after startup timeout or worker failure", () => {
    vi.useFakeTimers();
    const slow = setup(); slow.engine.start(); slow.engine.push(frame());
    vi.advanceTimersByTime(5001);
    expect(slow.worker.terminate).toHaveBeenCalledOnce();
    expect(slow.engine.getDiagnostics()).toEqual({ requested: "wlipsync", actual: "analyzer", state: "failed" });
    expect(slow.engine.sample().mouthOpenY).toBe(0.8);
    slow.engine.dispose();
    const { engine, worker, advance } = setup();
    engine.start(); worker.send({ type: "ready" }); engine.push(frame());
    advance(121); worker.result(); engine.push(frame());
    expect(engine.getDiagnostics().actual).toBe("analyzer");
    worker.send({ type: "failed" });
    expect(engine.sample().mouthOpenY).toBe(0.8);
    expect(worker.terminate).toHaveBeenCalledOnce();
    engine.dispose();
  });

  it("ignores startup/results after disposal and releases all worker callbacks", () => {
    const { engine, worker, fallback } = setup();
    engine.start();
    const callback = worker.onmessage!;
    engine.dispose();
    callback({ data: { type: "ready" } } as MessageEvent<LipSyncWorkerOutput>);
    engine.push(frame());
    expect(fallback.push).not.toHaveBeenCalled();
    expect(worker.onmessage).toBeNull(); expect(worker.onerror).toBeNull();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(engine.getDiagnostics().state).toBe("disposed");
    expect(engine.sample().mouthOpenY).toBe(0);
  });
});

describe("pinned wLipSync WASM (actual binary, no browser audio graph)", () => {
  it("executes its bundled MFCC profile, resets acoustic history, and supports input sample rates", async () => {
    const bytes = readFileSync(new URL("../node_modules/wlipsync/dist/wlipsync.wasm", import.meta.url));
    const core = await WLipSyncCore.create(bytes);
    for (const sampleRate of [48000, 24000, 44100]) {
      const samples = Float32Array.from({ length: Math.ceil(sampleRate * 0.08) }, (_, i) => 0.2 * Math.sin(i * 2 * Math.PI * 220 / sampleRate));
      const result = core.analyze(samples, sampleRate);
      expect(["A", "I", "U", "E", "O"]).toContain(result.name);
      expect(result.volume).toBeGreaterThan(0.01);
      core.reset();
      expect(core.analyze(new Float32Array(samples.length), sampleRate).volume).toBeLessThan(1e-6);
    }
    expect(() => core.analyze(new Float32Array(10), 0)).toThrow("WLIPSYNC_SAMPLE_RATE_UNSUPPORTED");
  });
});
