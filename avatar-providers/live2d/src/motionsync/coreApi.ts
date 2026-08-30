/**
 * Type surface of the proprietary `live2dcubismmotionsynccore.min.js` global, as consumed by
 * Live2D's CubismWebMotionSyncComponents framework (reference/CubismWebMotionSyncComponents/Framework/src).
 * The Core itself is NOT included in this repository (BLOCKED_BY_MOTIONSYNC_CORE); this file only
 * declares the shape our port calls so that the wiring is complete and unit-testable with a fake.
 */
export interface MotionSyncCoreContext {
  csmMotionSyncCreate(contextConfigPtr: number, mappingInfoListPtr: number, mappingInfoListCount: number): void;
  csmMotionSyncClear(): void;
  csmMotionSyncDelete(): void;
  csmMotionSyncGetRequireSampleCount(): number;
  csmMotionSyncAnalyze(samplesPtr: number, sampleCount: number, analysisResultPtr: number, analysisConfigPtr: number): number;
}

export interface MotionSyncCoreApi {
  csmMotionSyncTrue: number;
  csmMotionSyncFalse: number;
  Logging: { csmMotionSyncSetLogFunction(fn: (message: string) => void): void };
  CubismMotionSyncEngine: {
    csmMotionSyncGetEngineVersion(): number;
    csmMotionSyncGetEngineName(): string;
    csmMotionSyncInitializeEngine(engineConfigPtr: number): number;
    csmMotionSyncDisposeEngine(): void;
  };
  Context: new () => MotionSyncCoreContext;
  ToPointer: {
    Malloc(bytes: number): number;
    Free(ptr: number): void;
    ConvertNumberArrayToFloatArrayPtr(samples: number[]): number;
    AddValuePtrFloat(ptr: number, byteOffset: number, value: number): void;
    AddValuePtrInt32(ptr: number, byteOffset: number, value: number): void;
    ConvertContextConfigCriToInt32Array(buffer: Int32Array, ptr: number, sampleRate: number, bitDepth: number): Int32Array;
    ConvertAnalysisConfigToFloat32Array(buffer: Float32Array, ptr: number, blendRatio: number, smoothing: number, audioLevelEffectRatio: number): Float32Array;
    ConvertAnalysisResultToInt32Array(buffer: Int32Array, ptr: number, valuesCount: number): Int32Array;
    ConvertMappingInfoCriToFloat32Array(buffer: Float32Array, ptr: number, audioParameterId: string, modelParameterIds: string[], modelParameterValues: number[], count: number, scale: number, enabled: number): Float32Array;
    GetValuesFromAnalysisResult(valuesPtr: number, valuesCount: number): number[];
    GetProcessedSampleCountFromAnalysisResult(ptr: number): number;
  };
}

export const MOTIONSYNC_CORE_GLOBAL = "Live2DCubismMotionSyncCore";
export const CRI_ENGINE_NAME = "Live2DCubismMotionSyncEngine_CRI";

export function getMotionSyncCore(): MotionSyncCoreApi | null {
  const g = globalThis as unknown as Record<string, unknown>;
  return (g[MOTIONSYNC_CORE_GLOBAL] as MotionSyncCoreApi | undefined) ?? null;
}
