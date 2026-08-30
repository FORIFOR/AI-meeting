/**
 * Streaming linear-interpolation resampler.
 * Good enough for speech (16k/24k <-> 48k); keeps fractional phase across calls so
 * chunk boundaries do not click.
 */
export interface Resampler {
  readonly from: number;
  readonly to: number;
  process(input: Float32Array): Float32Array;
  reset(): void;
}

/** Stateful 2nd-order Butterworth low-pass (RBJ biquad), used as an anti-alias filter. */
function createLowPass(sampleRate: number, cutoff: number) {
  const w0 = (2 * Math.PI * cutoff) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (1 - cosw) / 2 / a0;
  const b1 = (1 - cosw) / a0;
  const b2 = b0;
  const a1 = (-2 * cosw) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return {
    process(input: Float32Array): Float32Array {
      const out = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const x0 = input[i] ?? 0;
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        out[i] = y0;
      }
      return out;
    },
    reset() { x1 = x2 = y1 = y2 = 0; },
  };
}

export function createResampler(from: number, to: number): Resampler {
  if (from === to) {
    return { from, to, process: (i) => i, reset: () => {} };
  }
  const ratio = from / to;
  // Downsampling: two cascaded biquads (≈ -24 dB/oct each) below 0.45 × target Nyquist keep
  // >8 kHz content out of the 16 kHz STT/VAD band.
  const lp = from > to ? [createLowPass(from, 0.45 * to), createLowPass(from, 0.45 * to)] : [];
  let last = 0; // last input sample of previous chunk
  let phase = 0; // fractional read position relative to `last` (0..1 => between last and input[0])
  let primed = false;

  return {
    from,
    to,
    reset() {
      last = 0;
      phase = 0;
      primed = false;
      for (const f of lp) f.reset();
    },
    process(raw: Float32Array): Float32Array {
      if (raw.length === 0) return new Float32Array(0);
      let input = raw;
      for (const f of lp) input = f.process(input);
      // Virtual buffer = [last, ...input]; positions are in that space.
      const virtualLen = input.length + 1;
      const get = (i: number) => (i === 0 ? last : (input[i - 1] ?? 0));
      if (!primed) {
        last = input[0] ?? 0;
        primed = true;
        phase = 1; // start exactly on input[0]
      }
      const outSamples: number[] = [];
      let pos = phase;
      while (pos < virtualLen - 1) {
        const i0 = Math.floor(pos);
        const frac = pos - i0;
        const a = get(i0);
        const b = get(i0 + 1);
        outSamples.push(a + (b - a) * frac);
        pos += ratio;
      }
      // Carry over.
      last = input[input.length - 1] ?? 0;
      phase = pos - (virtualLen - 1);
      return Float32Array.from(outSamples);
    },
  };
}

/** One-shot resample (non-streaming). */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  return createResampler(from, to).process(input);
}
