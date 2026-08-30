/**
 * Port of `CubismMotionSync` (reference/CubismWebMotionSyncComponents/Framework/src/live2dcubismmotionsync.ts,
 * Live2D Open Software License). Differences from the original:
 *  - takes a structural `ParameterModel` instead of CubismModel (pixi-live2d-display's coreModel fits)
 *  - arrays instead of csmVector; parsed JSON instead of CubismJson
 *  - `updateParameters` returns the parameter writes it performed (for tests and for our MotionStack)
 */
import { MotionSyncCriEngine, type MotionSyncProcessor } from "./engine.js";
import { buildMappingInfoList, type MotionSyncData, type MotionSyncSetting } from "./data.js";

export interface ParameterModel {
  /** -1 when the id does not exist. */
  getParameterIndex(id: string): number;
  getParameterValueByIndex(index: number): number;
  setParameterValueByIndex(index: number, value: number): void;
}

interface ProcessorInfo {
  processor: MotionSyncProcessor;
  setting: MotionSyncSetting;
  parameterIndices: number[];
  blendRatio: number;
  smoothing: number;
  /** analysis fps */
  sampleRate: number;
  audioLevelEffectRatio: number;
  sampleBuffer: ArrayLike<number> | null;
  sampleBufferIndex: number;
  currentRemainTime: number;
  lastSmoothed: number[];
  lastDamped: number[];
  lastValues: number[];
  lastTotalProcessedCount: number;
}

export interface ParameterWrite {
  id: string;
  index: number;
  value: number;
}

export class CubismMotionSync {
  static create(model: ParameterModel, data: MotionSyncData, samplePerSec: number): CubismMotionSync {
    const engine = MotionSyncCriEngine.get() ?? MotionSyncCriEngine.initialize();
    const infos: ProcessorInfo[] = [];
    for (const setting of data.settings) {
      if (setting.analysisType !== "CRI") continue;
      const mapping = buildMappingInfoList(setting);
      const processor = engine.createProcessor(setting.cubismParameters.length, mapping, samplePerSec);
      const parameterIndices = setting.cubismParameters.map((p) => model.getParameterIndex(p.id));
      const initial = parameterIndices.map((i) => (i >= 0 ? model.getParameterValueByIndex(i) : 0));
      infos.push({
        processor,
        setting,
        parameterIndices,
        blendRatio: setting.blendRatio,
        smoothing: setting.smoothing,
        sampleRate: setting.sampleRate,
        audioLevelEffectRatio: 0,
        sampleBuffer: null,
        sampleBufferIndex: 0,
        currentRemainTime: 0,
        lastSmoothed: [...initial],
        lastDamped: [...initial],
        lastValues: initial.map(() => NaN),
        lastTotalProcessedCount: 0,
      });
    }
    return new CubismMotionSync(model, data, infos);
  }

  private constructor(private readonly model: ParameterModel, readonly data: MotionSyncData, private readonly infos: ProcessorInfo[]) {}

  get processorCount(): number {
    return this.infos.length;
  }

  setSoundBuffer(processIndex: number, buffer: ArrayLike<number>, startIndex: number): void {
    const info = this.infos[processIndex];
    if (!info) return;
    info.sampleBuffer = buffer;
    info.sampleBufferIndex = startIndex;
  }

  setBlendRatio(processIndex: number, blendRatio: number): void {
    const info = this.infos[processIndex];
    if (info) info.blendRatio = blendRatio;
  }

  setSmoothing(processIndex: number, smoothing: number): void {
    const info = this.infos[processIndex];
    if (info) info.smoothing = smoothing;
  }

  setSampleRate(processIndex: number, fps: number): void {
    const info = this.infos[processIndex];
    if (info) info.sampleRate = fps;
  }

  getLastTotalProcessedCount(processIndex: number): number {
    return this.infos[processIndex]?.lastTotalProcessedCount ?? 0;
  }

  /** Port of updateParameters(model, deltaTimeSeconds); returns every write performed. */
  updateParameters(deltaTimeSeconds: number): ParameterWrite[] {
    if (deltaTimeSeconds < 0) deltaTimeSeconds = 0;
    const writes: ParameterWrite[] = [];
    for (const info of this.infos) {
      info.currentRemainTime += deltaTimeSeconds;
      const processorDeltaTime = 1 / info.sampleRate;
      info.lastTotalProcessedCount = 0;
      if (info.currentRemainTime >= processorDeltaTime) {
        this.analyze(info);
        info.currentRemainTime = info.currentRemainTime - Math.floor(info.currentRemainTime / processorDeltaTime) * processorDeltaTime;
      }
      // Overwrite parameter values every frame to prevent data from replacing itself.
      info.setting.cubismParameters.forEach((p, targetIndex) => {
        const index = info.parameterIndices[targetIndex] ?? -1;
        const v = info.lastValues[targetIndex];
        if (v === undefined || Number.isNaN(v) || index < 0) return;
        const value = info.lastDamped[targetIndex] ?? 0;
        this.model.setParameterValueByIndex(index, value);
        writes.push({ id: p.id, index, value });
      });
    }
    return writes;
  }

  private analyze(info: ProcessorInfo): void {
    const samples = info.sampleBuffer;
    if (!samples) return;
    let beginIndex = info.sampleBufferIndex;
    const size = samples.length;
    let require = info.processor.getRequireSampleCount();
    for (let i = 0; i < size; i += require) {
      if (size === 0 || size <= beginIndex || size - beginIndex < require) break;
      const result = info.processor.analyze(samples, beginIndex, info.blendRatio, info.smoothing, info.audioLevelEffectRatio);
      if (!result) break;
      beginIndex += result.processedSampleCount;
      info.lastTotalProcessedCount += result.processedSampleCount;
      info.setting.cubismParameters.forEach((p, targetIndex) => {
        let cache = result.values[targetIndex] ?? NaN;
        if (Number.isNaN(cache)) return;
        info.lastValues[targetIndex] = cache;
        // Smoothing (percent of previous value kept)
        cache = ((100 - p.smooth) * cache + (info.lastSmoothed[targetIndex] ?? 0) * p.smooth) / 100;
        info.lastSmoothed[targetIndex] = cache;
        // Dampening
        if (Math.abs(cache - (info.lastDamped[targetIndex] ?? 0)) < p.damper) cache = info.lastDamped[targetIndex] ?? 0;
        info.lastDamped[targetIndex] = cache;
      });
      require = info.processor.getRequireSampleCount();
      if (result.processedSampleCount <= 0) break;
    }
  }

  /** Reset smoothing/damping state and drop any queued audio (used on interruption). */
  reset(): void {
    for (const info of this.infos) {
      info.sampleBuffer = null;
      info.sampleBufferIndex = 0;
      info.currentRemainTime = 0;
      info.lastTotalProcessedCount = 0;
      info.lastSmoothed = info.lastSmoothed.map(() => 0);
      info.lastDamped = info.lastDamped.map(() => 0);
      info.lastValues = info.lastValues.map(() => 0);
    }
  }

  release(): void {
    for (const info of this.infos) info.processor.close();
    this.infos.length = 0;
  }
}
