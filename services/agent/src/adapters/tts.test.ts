import { describe, expect, it } from "vitest";
import { guardPeaks, trimSilence } from "./tts.js";

const SR = 44100;
const ms = (n: number) => Math.round((n / 1000) * SR);
/** Silence, a 0.5 s tone, silence — the shape of every Supertonic phrase. */
function padded(leadMs: number, trailMs: number, amp = 8000): Int16Array {
  const tone = ms(500);
  const out = new Int16Array(ms(leadMs) + tone + ms(trailMs));
  for (let i = 0; i < tone; i++) out[ms(leadMs) + i] = Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SR));
  return out;
}

describe("trimSilence (Supertonic pads every phrase)", () => {
  it("cuts a 570 ms lead down to the kept 60 ms and a 545 ms tail down to 150 ms", () => {
    const out = trimSilence(padded(570, 545), SR);
    // ±10 ms: the scan works in 10 ms windows
    expect(out.length).toBeGreaterThanOrEqual(ms(60 + 500 + 150) - ms(10));
    expect(out.length).toBeLessThanOrEqual(ms(60 + 500 + 150) + ms(20));
    // the tone itself is intact: the loudest sample survives
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(7900);
  });

  it("leaves a phrase alone when its padding is already short", () => {
    const pcm = padded(30, 100);
    expect(trimSilence(pcm, SR)).toBe(pcm);
  });

  it("returns silence untouched rather than an empty phrase", () => {
    const pcm = new Int16Array(ms(800));
    expect(trimSilence(pcm, SR)).toBe(pcm);
  });

  it("ignores a faint noise floor (−46 dBFS) when deciding where speech starts", () => {
    const pcm = padded(400, 400);
    for (let i = 0; i < ms(400); i++) pcm[i] = (i % 2 ? 1 : -1) * 60; // ≈ −55 dBFS hiss
    const out = trimSilence(pcm, SR);
    expect(out.length).toBeLessThanOrEqual(ms(60 + 500 + 150) + ms(20));
  });
});

describe("guardPeaks (two denoising steps come out hot)", () => {
  it("scales a clipping phrase down to the ceiling and keeps its shape", () => {
    const pcm = Int16Array.from([32767, -32768, 16000, 0]);
    const out = guardPeaks(pcm, 0.95);
    expect(Math.max(...Array.from(out).map(Math.abs))).toBeLessThanOrEqual(Math.round(0.95 * 32767) + 1);
    expect(out[2]! / out[0]!).toBeCloseTo(16000 / 32767, 2);
  });

  it("does not touch a phrase under the ceiling", () => {
    const pcm = Int16Array.from([20000, -20000, 5000]);
    expect(guardPeaks(pcm)).toBe(pcm);
    expect(Array.from(pcm)).toEqual([20000, -20000, 5000]);
  });
});
