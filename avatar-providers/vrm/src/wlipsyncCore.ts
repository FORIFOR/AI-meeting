import type { Profile } from "wlipsync";
import calibration from "./wlipsync-profile.json";

// Calibration data: mrxz/wLipSync, commit 73d0170f500c2845a62a8fe4384a4729499e8426,
// example/profile.json. MIT notice is retained in wlipsync-profile.LICENSE.
// This adapter uses the WASM ABI shipped by the pinned wlipsync@1.3.1 package.
// See upstream www/audio-processor.js and tools/benchmark.js for the original ABI.
interface WLipSyncExports extends WebAssembly.Exports {
  load_profile: (...args: number[]) => number;
  precompute_profile: () => void;
  set_input: (sampleRate: number) => void;
  get_input_buffer: () => number;
  get_input_buffer_size: () => number;
  get_volume_ptr: () => number;
  execute: (index: number) => number;
}

export interface PhonemeResult { name: string; volume: number }

/** Pure analysis: no AudioContext, destination, microphone, or audio scheduling. */
export class WLipSyncCore {
  private input: Float32Array | null = null;
  private cursor = 0;
  private sampleRate = 0;

  private constructor(
    private readonly memory: WebAssembly.Memory,
    private readonly wasm: WLipSyncExports,
    private readonly profile: Profile,
  ) {}

  static async create(bytes: BufferSource): Promise<WLipSyncCore> {
    const memory = new WebAssembly.Memory({ initial: 4 });
    const { instance } = await WebAssembly.instantiate(bytes, { env: { memory } });
    const wasm = instance.exports as WLipSyncExports;
    const profile = calibration as Profile;
    const ptr = wasm.load_profile(profile.targetSampleRate, profile.sampleCount,
      profile.melFilterBankChannels, profile.compareMethod, profile.mfccs.length,
      profile.mfccDataCount, profile.useStandardization ? 1 : 0);
    const values = new DataView(memory.buffer, ptr, profile.mfccs.length * profile.mfccDataCount * 12 * 4);
    let offset = 0;
    for (const phoneme of profile.mfccs) {
      for (const sample of phoneme.mfccCalibrationDataList) {
        for (const value of sample.array) {
          values.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    }
    wasm.precompute_profile();
    return new WLipSyncCore(memory, wasm, profile);
  }

  reset(): void {
    this.input?.fill(0);
    this.cursor = 0;
  }

  analyze(data: Float32Array, sampleRate: number): PhonemeResult {
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000) {
      throw new Error("WLIPSYNC_SAMPLE_RATE_UNSUPPORTED");
    }
    if (sampleRate !== this.sampleRate) {
      this.wasm.set_input(sampleRate);
      this.sampleRate = sampleRate;
      this.input = new Float32Array(this.memory.buffer,
        this.wasm.get_input_buffer(), this.wasm.get_input_buffer_size());
      this.reset();
    }
    const input = this.input!;
    for (const sample of data) {
      input[this.cursor] = Number.isFinite(sample) ? sample : 0;
      this.cursor = (this.cursor + 1) % input.length;
    }
    const index = this.wasm.execute(this.cursor);
    const volume = new DataView(this.memory.buffer, this.wasm.get_volume_ptr(), 4).getFloat32(0, true);
    return {
      name: this.profile.mfccs[index]?.name ?? "silence",
      volume: Number.isFinite(volume) ? Math.max(0, volume) : 0,
    };
  }
}
