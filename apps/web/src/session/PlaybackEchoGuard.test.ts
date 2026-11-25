import { createFrame } from "@rcai/audio-core";
import { expect, it } from "vitest";
import { PlaybackEchoGuard } from "./PlaybackEchoGuard.js";

const size = 960;
const tone = (i: number) => 0.34 * Math.sin(i * 0.11 + Math.sin(i * 0.003)) + 0.15 * Math.sin(i * 0.074);

it("rejects 120 delayed quieter copies while keeping double-talk and its first frame intact", () => {
  const reference = Float32Array.from({ length: 11520 }, (_, i) => tone(i));
  for (let trial = 0; trial < 120; trial++) {
    const guard = new PlaybackEchoGuard();
    for (let offset = 0; offset < reference.length; offset += 512) {
      guard.playback(createFrame(reference.subarray(offset, offset + 512)));
    }
    const start = reference.length - size - (trial + 40) * 48;
    const scale = (4 + trial % 20) / 35;
    const echo = createFrame(Float32Array.from({ length: size }, (_, i) => scale * reference[start + i]!));
    expect(guard.filter(echo).data.every(sample => Math.abs(sample) < 1e-6)).toBe(true);
    const mixed = createFrame(echo.data.map((sample, i) => sample + 0.15 * Math.sin(i * 0.23)));
    expect(guard.filter(mixed)).toBe(mixed);
  }
});

it("passes silence, unrelated sound, unsupported rates and input after a reset", () => {
  const guard = new PlaybackEchoGuard();
  const reference = createFrame(Float32Array.from({ length: size }, (_, i) => tone(i)));
  guard.playback(reference);
  for (const original of [createFrame(new Float32Array(size)), createFrame(Float32Array.from({length:size}, (_,i)=>0.2*Math.sin(i*.31))), createFrame(reference.data, 44100)]) {
    expect(guard.filter(original)).toBe(original);
  }
  guard.reset();
  expect(guard.filter(reference)).toBe(reference);
});

it("subtracts an aligned echo without erasing a quieter overlapping onset", () => {
  const guard = new PlaybackEchoGuard();
  const reference = Float32Array.from({ length: size * 3 }, (_, i) => tone(i));
  guard.playback(createFrame(reference));
  const start = size;
  const voice = Float32Array.from({length:size}, (_, i) => 0.012 * Math.sin(i * 0.27));
  const mixed = createFrame(voice.map((sample, i) => sample + 0.5 * reference[start + i]!));
  const actual = guard.filter(mixed);
  expect(actual).not.toBe(mixed);
  const error = actual.data.reduce((sum, sample, i) => sum + (sample - voice[i]!) ** 2, 0);
  expect(error).toBeLessThan(0.004);
});
