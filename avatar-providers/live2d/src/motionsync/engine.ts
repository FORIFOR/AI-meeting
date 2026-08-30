/**
 * Core bindings — port of CubismMotionSyncEngineLib / CubismMotionSyncEngineController /
 * CubismMotionSyncEngineCri / CubismMotionSyncProcessorCRI / MappingInfoListMapper / *Config_CRI
 * (Live2D Open Software License; reference/CubismWebMotionSyncComponents/Framework/src).
 * Only the CRI engine exists today. Native pointer choreography follows the framework exactly so
 * that the real Core works unchanged once `live2dcubismmotionsynccore.min.js` is present.
 */
import { CRI_ENGINE_NAME, getMotionSyncCore, type MotionSyncCoreApi, type MotionSyncCoreContext } from "./coreApi.js";
import type { MappingInfo } from "./data.js";

export const DEFAULT_AUDIO_BIT_DEPTH = 32;
export const SAMPLE_RATE_MIN = 16000;
export const SAMPLE_RATE_MAX = 128000;
const MAPPING_INFO_STRUCT_SIZE = 6;

export class MotionSyncEngineError extends Error {}

export interface EngineVersion {
  major: number;
  minor: number;
  patch: number;
  raw: number;
}

let engineSingleton: MotionSyncCriEngine | null = null;

/** One initialised Core engine per page (the framework keeps a per-type map; only CRI exists). */
export class MotionSyncCriEngine {
  static get(): MotionSyncCriEngine | null {
    return engineSingleton;
  }

  static initialize(core: MotionSyncCoreApi | null = getMotionSyncCore(), engineConfigPtr = 0): MotionSyncCriEngine {
    if (engineSingleton) return engineSingleton;
    if (!core) throw new MotionSyncEngineError("Live2DCubismMotionSyncCore global is not loaded");
    const name = core.CubismMotionSyncEngine.csmMotionSyncGetEngineName();
    if (name !== CRI_ENGINE_NAME) throw new MotionSyncEngineError(`unsupported MotionSync engine "${name}"`);
    const ok = core.CubismMotionSyncEngine.csmMotionSyncInitializeEngine(engineConfigPtr);
    if (ok === core.csmMotionSyncFalse) throw new MotionSyncEngineError("csmMotionSyncInitializeEngine failed");
    const raw = core.CubismMotionSyncEngine.csmMotionSyncGetEngineVersion();
    engineSingleton = new MotionSyncCriEngine(core, name, { major: (raw & 0xff000000) >>> 24, minor: (raw & 0x00ff0000) >> 16, patch: raw & 0xffff, raw });
    return engineSingleton;
  }

  static dispose(): void {
    if (!engineSingleton) return;
    for (const p of [...engineSingleton.processors]) p.close();
    engineSingleton.core.CubismMotionSyncEngine.csmMotionSyncDisposeEngine();
    engineSingleton = null;
  }

  readonly processors: MotionSyncProcessor[] = [];
  private constructor(readonly core: MotionSyncCoreApi, readonly name: string, readonly version: EngineVersion) {}

  /** Port of CubismMotionSyncEngineCri.CreateProcessor. */
  createProcessor(cubismParameterCount: number, mappingInfoList: MappingInfo[], sampleRate: number): MotionSyncProcessor {
    if (mappingInfoList.length < 1) throw new MotionSyncEngineError("mappingInfoList is empty");
    if (!(SAMPLE_RATE_MIN <= sampleRate && sampleRate <= SAMPLE_RATE_MAX)) throw new MotionSyncEngineError(`sampleRate ${sampleRate} out of range`);
    const { ToPointer } = this.core;

    // MotionSyncContextConfig_CRI → Int32Array[2] {sampleRate, bitDepth}
    const contextConfigPtr = ToPointer.Malloc(2 * Int32Array.BYTES_PER_ELEMENT);
    ToPointer.ConvertContextConfigCriToInt32Array(new Int32Array(2), contextConfigPtr, sampleRate, DEFAULT_AUDIO_BIT_DEPTH);

    // MappingInfoListMapper → contiguous native struct array (6 × 4 bytes each; element 4 is the float scale).
    const infoBuffers = mappingInfoList.map((info) => {
      const ptr = ToPointer.Malloc(MAPPING_INFO_STRUCT_SIZE * Float32Array.BYTES_PER_ELEMENT);
      return ToPointer.ConvertMappingInfoCriToFloat32Array(new Float32Array(MAPPING_INFO_STRUCT_SIZE), ptr, info.audioParameterId, info.modelParameterIds, info.modelParameterValues, info.modelParameterIds.length, info.scale, Number(info.enabled));
    });
    const listPtr = ToPointer.Malloc(MAPPING_INFO_STRUCT_SIZE * mappingInfoList.length * Float32Array.BYTES_PER_ELEMENT);
    let cursor = listPtr;
    for (const buf of infoBuffers) {
      for (let i = 0; i < MAPPING_INFO_STRUCT_SIZE; i++) {
        const off = i * Float32Array.BYTES_PER_ELEMENT;
        if (i === 4) ToPointer.AddValuePtrFloat(cursor, off, buf[i] ?? 0);
        else ToPointer.AddValuePtrInt32(cursor, off, buf[i] ?? 0);
      }
      cursor += MAPPING_INFO_STRUCT_SIZE * Float32Array.BYTES_PER_ELEMENT;
    }

    const context = new this.core.Context();
    context.csmMotionSyncCreate(contextConfigPtr, listPtr, mappingInfoList.length);
    const processor = new MotionSyncProcessor(this, context, mappingInfoList, cubismParameterCount, sampleRate, { contextConfigPtr, listPtr, infoBuffers });
    this.processors.push(processor);
    return processor;
  }

  /** @internal */
  _forget(p: MotionSyncProcessor): void {
    const i = this.processors.indexOf(p);
    if (i >= 0) this.processors.splice(i, 1);
  }
}

export interface AnalysisResult {
  /** one value per cubism parameter (NaN = untouched) */
  values: number[];
  processedSampleCount: number;
}

/** Port of CubismMotionSyncProcessorCRI + CubismMotionSyncEngineAnalysisResult. */
export class MotionSyncProcessor {
  private analysisConfigPtr = 0;
  private analysisResultPtr = 0;
  private resultArray: Int32Array | null = null;
  private samplesPtr = 0;
  private closed = false;
  readonly valuesCount: number;

  constructor(
    readonly engine: MotionSyncCriEngine,
    private context: MotionSyncCoreContext | null,
    readonly mappingInfoList: MappingInfo[],
    cubismParameterCount: number,
    readonly sampleRate: number,
    private readonly native: { contextConfigPtr: number; listPtr: number; infoBuffers: Float32Array[] },
  ) {
    this.valuesCount = mappingInfoList[0]?.modelParameterValues.length ?? cubismParameterCount;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getRequireSampleCount(): number {
    if (!this.context) return 0;
    return this.context.csmMotionSyncGetRequireSampleCount();
  }

  /**
   * Analyse `samples[beginIndex..]` (float PCM in [-1,1] at `sampleRate`).
   * Returns null when the Core rejects the call (mirrors the framework's CubismLogError paths).
   */
  analyze(samples: ArrayLike<number>, beginIndex: number, blendRatio: number, smoothing: number, audioLevelEffectRatio = 0): AnalysisResult | null {
    if (!this.context) return null;
    const total = samples.length;
    const require = this.getRequireSampleCount();
    if (total < require) return null;
    if (!(0 <= beginIndex && beginIndex < total)) return null;
    if (!(0 <= blendRatio && blendRatio <= 1)) return null;
    if (!(1 <= smoothing && smoothing <= 100)) return null;
    if (!(0 <= audioLevelEffectRatio && audioLevelEffectRatio <= 1)) return null;
    const { ToPointer } = this.engine.core;

    // MotionSyncAnalysisConfig_CRI → {float blendRatio, int32 smoothing, float audioLevelEffectRatio}
    if (!this.analysisConfigPtr) this.analysisConfigPtr = ToPointer.Malloc(3 * Float32Array.BYTES_PER_ELEMENT);
    const cfg = ToPointer.ConvertAnalysisConfigToFloat32Array(new Float32Array(3), this.analysisConfigPtr, blendRatio, smoothing, audioLevelEffectRatio);
    ToPointer.AddValuePtrFloat(this.analysisConfigPtr, 0, cfg[0] ?? blendRatio);
    ToPointer.AddValuePtrInt32(this.analysisConfigPtr, 4, cfg[1] ?? smoothing);
    ToPointer.AddValuePtrFloat(this.analysisConfigPtr, 8, cfg[2] ?? audioLevelEffectRatio);

    // Analysis result struct {values*, valuesCount, processedSampleCount}
    if (!this.resultArray) {
      this.resultArray = ToPointer.ConvertAnalysisResultToInt32Array(new Int32Array(this.valuesCount), ToPointer.Malloc(this.valuesCount * Int32Array.BYTES_PER_ELEMENT), this.valuesCount);
    }
    if (!this.analysisResultPtr) this.analysisResultPtr = ToPointer.Malloc(3 * Int32Array.BYTES_PER_ELEMENT);
    ToPointer.AddValuePtrInt32(this.analysisResultPtr, 0, this.resultArray[0] ?? 0);
    ToPointer.AddValuePtrInt32(this.analysisResultPtr, 4, this.resultArray[1] ?? this.valuesCount);
    ToPointer.AddValuePtrInt32(this.analysisResultPtr, 8, this.resultArray[2] ?? 0);

    // Samples → native float array (framework copies [beginIndex, total) every call).
    const count = total - beginIndex;
    const chunk = new Array<number>(count);
    for (let i = 0; i < count; i++) chunk[i] = samples[beginIndex + i] ?? 0;
    if (this.samplesPtr) ToPointer.Free(this.samplesPtr);
    this.samplesPtr = ToPointer.ConvertNumberArrayToFloatArrayPtr(chunk);

    const ok = this.context.csmMotionSyncAnalyze(this.samplesPtr, count, this.analysisResultPtr, this.analysisConfigPtr);
    if (ok !== this.engine.core.csmMotionSyncTrue) return null;
    const values = ToPointer.GetValuesFromAnalysisResult(this.resultArray[0] ?? 0, this.valuesCount);
    const processedSampleCount = ToPointer.GetProcessedSampleCountFromAnalysisResult(this.analysisResultPtr + 8);
    return { values, processedSampleCount };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const { ToPointer } = this.engine.core;
    this.context?.csmMotionSyncDelete();
    this.context = null;
    if (this.samplesPtr) ToPointer.Free(this.samplesPtr);
    if (this.analysisConfigPtr) ToPointer.Free(this.analysisConfigPtr);
    if (this.resultArray) ToPointer.Free(this.resultArray[0] ?? 0);
    if (this.analysisResultPtr) ToPointer.Free(this.analysisResultPtr);
    ToPointer.Free(this.native.contextConfigPtr);
    ToPointer.Free(this.native.listPtr);
    this.engine._forget(this);
  }
}
