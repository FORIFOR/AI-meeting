import { describe, expect, it } from "vitest";
import { AudioNormalizer, OutboundAudioConverter } from "./normalizer.js";
import { createResampler } from "./resample.js";
import { base64Pcm16ToFloat32, float32ToBase64Pcm16, float32ToInt16, int16ToFloat32, rms } from "./pcm.js";
import { EnergyVAD } from "./vad.js";
import { LatencyTracker } from "./metrics.js";
import { createFrame } from "./types.js";

function sine(freq: number, rate: number, ms: number, amp = 0.5): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe("resampler", () => {
  it("changes length by ratio and is streaming-stable", () => {
    const r = createResampler(16000, 48000);
    const whole = sine(440, 16000, 40);
    const a = r.process(whole.subarray(0, 320));
    const b = r.process(whole.subarray(320));
    expect(a.length + b.length).toBeGreaterThanOrEqual(1918);
    expect(a.length + b.length).toBeLessThanOrEqual(1922);
    // No discontinuity larger than a sample step at the boundary.
    const last = a[a.length - 1]!;
    const first = b[0]!;
    expect(Math.abs(first - last)).toBeLessThan(0.1);
  });
  it("attenuates content above the target Nyquist when downsampling (anti-alias)", () => {
    const r = createResampler(48000, 16000);
    r.process(sine(12000, 48000, 100)); // let the filter settle
    const high = r.process(sine(12000, 48000, 200));
    const low = createResampler(48000, 16000).process(sine(1000, 48000, 300)).subarray(1600);
    expect(rms(high) / rms(low)).toBeLessThan(0.1); // > 20 dB down
  });
  it("downsamples 48k -> 16k", () => {
    const out = createResampler(48000, 16000).process(sine(200, 48000, 100));
    expect(Math.abs(out.length - 1600)).toBeLessThanOrEqual(1);
    expect(rms(out)).toBeCloseTo(rms(sine(200, 16000, 100)), 1);
  });
});

describe("pcm helpers", () => {
  it("round-trips float32 <-> int16 <-> base64", () => {
    const src = sine(300, 24000, 10);
    const b64 = float32ToBase64Pcm16(src);
    const back = base64Pcm16ToFloat32(b64);
    expect(back.length).toBe(src.length);
    for (let i = 0; i < src.length; i += 7) expect(back[i]).toBeCloseTo(src[i]!, 3);
    expect(int16ToFloat32(float32ToInt16(new Float32Array([1, -1, 0]))).every((v) => Math.abs(v) <= 1)).toBe(true);
  });
});

describe("normalizer", () => {
  it("outputs 48k mono regardless of input", () => {
    const n = new AudioNormalizer();
    const frames: number[] = [];
    n.onFrame((f) => frames.push(f.sampleRate));
    const stereo = new Float32Array(2 * 240);
    for (let i = 0; i < 240; i++) {
      stereo[i * 2] = 0.5;
      stereo[i * 2 + 1] = -0.5;
    }
    const out = n.push({ data: stereo, sampleRate: 24000, channels: 2 });
    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toBe(1);
    expect(Math.abs(out.data.length - 480)).toBeLessThanOrEqual(2);
    expect(rms(out.data)).toBeLessThan(1e-6);
    expect(frames).toEqual([48000]);
  });
  it("outbound converter emits fixed-size int16 chunks at provider rate", () => {
    const c = new OutboundAudioConverter({ targetRate: 16000, chunkMs: 20 });
    const chunks = [
      ...c.push(createFrame(sine(440, 48000, 30))),
      ...c.push(createFrame(sine(440, 48000, 30))),
    ];
    expect(chunks.length).toBe(3);
    expect(chunks.every((ch) => ch.length === 320)).toBe(true);
    const rest = c.flush();
    expect(rest).toBeNull();
  });
});

describe("EnergyVAD", () => {
  it("detects speech start and end", () => {
    const vad = new EnergyVAD({ minSpeechMs: 40, hangoverMs: 100 });
    const events: import("./vad.js").VADEvent[] = [];
    let ts = 0;
    const push = (amp: number, ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        const f = createFrame(sine(200, 48000, 20, amp), 48000, ts);
        events.push(...vad.process(f));
        ts += 20;
      }
    };
    push(0.001, 400); // noise floor
    push(0.4, 300); // speech
    push(0.001, 300); // silence
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = events[1] as { durationMs: number };
    expect(end.durationMs).toBeGreaterThan(200);
    expect(end.durationMs).toBeLessThan(400);
  });
});

describe("EnergyVAD steady noise", () => {
  it("learns a constant background level instead of reporting endless speech", () => {
    const vad = new EnergyVAD({ minSpeechMs: 40, hangoverMs: 100 });
    let ts = 0;
    let starts = 0;
    let ends = 0;
    for (let t = 0; t < 30000; t += 20) {
      for (const e of vad.process(createFrame(sine(200, 48000, 20, 0.02), 48000, ts))) {
        if (e.type === "speech_start") starts++;
        else ends++;
      }
      ts += 20;
    }
    expect(starts).toBeLessThanOrEqual(1);
    expect(ends).toBe(starts); // any initial false start is closed once the floor adapts
    expect(vad.isSpeaking).toBe(false);
  });
});

describe("LatencyTracker", () => {
  it("computes turn response percentiles", () => {
    let t = 0;
    const tracker = new LatencyTracker(() => t);
    for (const gap of [500, 600, 700, 900, 1400]) {
      tracker.mark("user_speech_ended");
      t += gap;
      tracker.mark("assistant_speech_started");
      t += 1000;
    }
    const s = tracker.summary("turn_response");
    expect(s.count).toBe(5);
    expect(s.p50).toBe(700);
    expect(s.p95).toBe(1400);
    tracker.mark("interrupt_requested");
    t += 40;
    tracker.mark("audio_stopped");
    expect(tracker.summary("interrupt_stop").max).toBe(40);
    // A dangling mark from an earlier turn must not become a 10 s "listening" sample.
    tracker.mark("user_speech_started");
    t += 10_118;
    tracker.mark("avatar_listening");
    expect(tracker.summary("listening_react").count).toBe(0);
    expect(tracker.discarded.listening_react).toBe(1);
  });
});
