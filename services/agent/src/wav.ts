/** Minimal RIFF/WAVE parser that tolerates JUNK/FLLR chunks (macOS `say` emits them). */
export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm16: Int16Array;
}

export function parseWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAVE file");
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let data: Uint8Array | null = null;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "data") {
      data = bytes.subarray(body, Math.min(bytes.byteLength, body + size));
      break;
    }
    offset = body + size + (size & 1);
  }
  if (!data || !sampleRate) throw new Error("WAVE: missing fmt/data");
  if (bitsPerSample !== 16) throw new Error(`WAVE: unsupported bits ${bitsPerSample}`);
  const aligned = new Uint8Array(data.byteLength - (data.byteLength % 2));
  aligned.set(data.subarray(0, aligned.length));
  let pcm16 = new Int16Array(aligned.buffer);
  if (channels > 1) {
    const mono = new Int16Array(Math.floor(pcm16.length / channels));
    for (let i = 0; i < mono.length; i++) {
      let s = 0;
      for (let c = 0; c < channels; c++) s += pcm16[i * channels + c] ?? 0;
      mono[i] = s / channels;
    }
    pcm16 = mono;
    channels = 1;
  }
  return { sampleRate, channels, bitsPerSample, pcm16 };
}

export function encodeWav(pcm16: Int16Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm16.byteLength);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, "RIFF"); v.setUint32(4, 36 + pcm16.byteLength, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, pcm16.byteLength, true);
  out.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), 44);
  return out;
}
