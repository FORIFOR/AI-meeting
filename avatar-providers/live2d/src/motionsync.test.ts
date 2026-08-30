import { describe, expect, it, beforeEach } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { parseMotionSyncJson, buildMappingInfoList } from "./motionsync/data.js";
import { MotionSyncCriEngine } from "./motionsync/engine.js";
import { CubismMotionSync, type ParameterModel } from "./motionsync/cubismMotionSync.js";
import { MotionSyncLipSync, MotionSyncUnavailableError } from "./motionSync.js";
import type { MotionSyncCoreApi, MotionSyncCoreContext } from "./motionsync/coreApi.js";

/** Kei_basic-style setting: Silence/A/I/U/E/O → ParamMouthForm + ParamMouthOpenY (values copied from the sample). */
const KEI_LIKE = {
  Version: 1,
  Meta: { SettingCount: 1, Dictionary: [{ Id: "MotionSyncSetting", Name: "Basic_CRI" }] },
  Settings: [
    {
      Id: "MotionSyncSetting",
      AnalysisType: "CRI",
      UseCase: "Mouth",
      CubismParameters: [
        { Name: "口 変形", Id: "ParamMouthForm", Min: -1, Max: 1, Damper: 0, Smooth: 25 },
        { Name: "口 開閉", Id: "ParamMouthOpenY", Min: 0, Max: 1, Damper: 0, Smooth: 25 },
      ],
      AudioParameters: [
        { Name: "Silence", Id: "Silence", Min: 0, Max: 1, Scale: 1, Enabled: true },
        { Name: "A", Id: "A", Min: 0, Max: 1, Scale: 0.3, Enabled: true },
        { Name: "I", Id: "I", Min: 0, Max: 1, Scale: 1, Enabled: true },
        { Name: "U", Id: "U", Min: 0, Max: 1, Scale: 1.5, Enabled: true },
        { Name: "E", Id: "E", Min: 0, Max: 1, Scale: 6, Enabled: true },
        { Name: "O", Id: "O", Min: 0, Max: 1, Scale: 8, Enabled: true },
      ],
      Mappings: [
        { Type: "Shape", Id: "Silence", Targets: [{ Id: "ParamMouthForm", Value: 0 }, { Id: "ParamMouthOpenY", Value: 0 }] },
        { Type: "Shape", Id: "A", Targets: [{ Id: "ParamMouthForm", Value: 1 }, { Id: "ParamMouthOpenY", Value: 1 }] },
        { Type: "Shape", Id: "I", Targets: [{ Id: "ParamMouthForm", Value: 1 }, { Id: "ParamMouthOpenY", Value: 0.4 }] },
        { Type: "Shape", Id: "U", Targets: [{ Id: "ParamMouthForm", Value: -1 }, { Id: "ParamMouthOpenY", Value: 0.4 }] },
        { Type: "Shape", Id: "E", Targets: [{ Id: "ParamMouthForm", Value: 1 }, { Id: "ParamMouthOpenY", Value: 0.7 }] },
        { Type: "Shape", Id: "O", Targets: [{ Id: "ParamMouthForm", Value: -1 }, { Id: "ParamMouthOpenY", Value: 1 }] },
      ],
      PostProcessing: { BlendRatio: 0.5, Smoothing: 60, SampleRate: 60 },
    },
  ],
};

/**
 * Fake `Live2DCubismMotionSyncCore`: emulates the pointer API with a JS heap and an "analysis" that
 * maps RMS of the analysed window to the mouth parameters (values array = per cubism parameter).
 * It records every call so the wiring can be asserted without the proprietary Core.
 */
function createFakeCore() {
  const heap = new Map<number, unknown>();
  let next = 16;
  const calls: string[] = [];
  const alloc = (v: unknown) => { const p = next; next += 64; heap.set(p, v); return p; };
  const REQUIRE = 480; // 10 ms @ 48k
  class Context implements MotionSyncCoreContext {
    created: { configPtr: number; listPtr: number; count: number } | null = null;
    csmMotionSyncCreate(configPtr: number, listPtr: number, count: number) { this.created = { configPtr, listPtr, count }; calls.push(`create(count=${count},rate=${(heap.get(configPtr) as { sampleRate: number }).sampleRate})`); }
    csmMotionSyncClear() { calls.push("clear"); }
    csmMotionSyncDelete() { calls.push("delete"); }
    csmMotionSyncGetRequireSampleCount() { return REQUIRE; }
    csmMotionSyncAnalyze(samplesPtr: number, sampleCount: number, resultPtr: number, configPtr: number) {
      const samples = heap.get(samplesPtr) as number[];
      const n = Math.min(REQUIRE, sampleCount);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += samples[i]! ** 2;
      const rms = Math.sqrt(sum / n);
      const open = Math.min(1, rms * 4);
      const result = heap.get(resultPtr) as { valuesPtr: number; count: number; processed: number };
      const cfg = heap.get(configPtr) as { blendRatio: number; smoothing: number };
      calls.push(`analyze(n=${sampleCount},blend=${cfg.blendRatio},smooth=${cfg.smoothing})`);
      heap.set(result.valuesPtr, [open > 0.05 ? 0.6 : 0, open]); // [ParamMouthForm, ParamMouthOpenY]
      result.processed = n;
      return 1;
    }
  }
  const core: MotionSyncCoreApi & { calls: string[]; heap: Map<number, unknown> } = {
    calls,
    heap,
    csmMotionSyncTrue: 1,
    csmMotionSyncFalse: 0,
    Logging: { csmMotionSyncSetLogFunction: () => {} },
    CubismMotionSyncEngine: {
      csmMotionSyncGetEngineVersion: () => (1 << 24) | (2 << 16) | 3,
      csmMotionSyncGetEngineName: () => "Live2DCubismMotionSyncEngine_CRI",
      csmMotionSyncInitializeEngine: (p) => { calls.push(`init(${p})`); return 1; },
      csmMotionSyncDisposeEngine: () => calls.push("disposeEngine"),
    },
    Context,
    ToPointer: {
      Malloc: (bytes) => alloc({ bytes }),
      Free: (p) => { heap.delete(p); },
      ConvertNumberArrayToFloatArrayPtr: (arr) => alloc(arr),
      AddValuePtrFloat: (ptr, off, v) => { const o = heap.get(ptr) as Record<string, unknown>; if (o) o[`f${off}`] = v; },
      AddValuePtrInt32: (ptr, off, v) => { const o = heap.get(ptr) as Record<string, unknown>; if (o) o[`i${off}`] = v; },
      ConvertContextConfigCriToInt32Array: (buf, ptr, sampleRate, bitDepth) => { heap.set(ptr, { sampleRate, bitDepth }); buf[0] = sampleRate; buf[1] = bitDepth; return buf; },
      ConvertAnalysisConfigToFloat32Array: (buf, ptr, blend, smooth, ratio) => { heap.set(ptr, { blendRatio: blend, smoothing: smooth, ratio }); buf[0] = blend; buf[1] = smooth; buf[2] = ratio; return buf; },
      ConvertAnalysisResultToInt32Array: (buf, ptr, count) => { const valuesPtr = alloc(new Array(count).fill(NaN)); heap.set(ptr, { valuesPtr, count, processed: 0 }); buf[0] = valuesPtr; buf[1] = count; buf[2] = 0; return buf; },
      ConvertMappingInfoCriToFloat32Array: (buf, ptr, audioId, ids, values, count, scale, enabled) => { heap.set(ptr, { audioId, ids, values, count, scale, enabled }); calls.push(`mapping(${audioId}:${ids.join("/")}=${values.join("/")} ×${scale})`); buf[4] = scale; buf[5] = enabled; return buf; },
      GetValuesFromAnalysisResult: (valuesPtr) => [...(heap.get(valuesPtr) as number[])],
      GetProcessedSampleCountFromAnalysisResult: (ptrPlus8) => (heap.get(ptrPlus8 - 8) as { processed: number }).processed,
    },
  };
  // analysisResultPtr is a Malloc'd struct; AddValuePtrInt32(ptr,0,valuesPtr) links it to the values buffer.
  const origAdd = core.ToPointer.AddValuePtrInt32;
  core.ToPointer.AddValuePtrInt32 = (ptr, off, v) => {
    origAdd(ptr, off, v);
    const o = heap.get(ptr) as Record<string, unknown>;
    if (o && off === 0 && heap.has(v)) { o.valuesPtr = v; o.count = (heap.get(v) as number[]).length; if (o.processed === undefined) o.processed = 0; }
  };
  return core;
}

function fakeModel(ids: string[]): ParameterModel & { values: number[] } {
  const values = ids.map(() => 0);
  return {
    values,
    getParameterIndex: (id) => ids.indexOf(id),
    getParameterValueByIndex: (i) => values[i] ?? 0,
    setParameterValueByIndex: (i, v) => { values[i] = v; },
  };
}

function tone(ms: number, amp: number, rate = 48000): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
  return out;
}

describe("motionsync3 parsing", () => {
  it("parses settings, parameters and mapping info like CubismMotionSyncData", () => {
    const data = parseMotionSyncJson(KEI_LIKE);
    expect(data.settings.length).toBe(1);
    const s = data.settings[0]!;
    expect(s.analysisType).toBe("CRI");
    expect(s.cubismParameters.map((p) => p.id)).toEqual(["ParamMouthForm", "ParamMouthOpenY"]);
    expect(s.blendRatio).toBe(0.5);
    expect(s.smoothing).toBe(60);
    expect(s.sampleRate).toBe(60);
    const infos = buildMappingInfoList(s);
    expect(infos.map((i) => i.audioParameterId)).toEqual(["Silence", "A", "I", "U", "E", "O"]);
    expect(infos[5]).toEqual({ audioParameterId: "O", modelParameterIds: ["ParamMouthForm", "ParamMouthOpenY"], modelParameterValues: [-1, 1], scale: 8, enabled: true });
    expect(() => parseMotionSyncJson({})).toThrow(/Settings missing/);
  });
});

describe("MotionSync port with a fake Core", () => {
  beforeEach(() => MotionSyncCriEngine.dispose());

  it("initialises the engine, marshals the mapping list and drives model parameters from audio", () => {
    const core = createFakeCore();
    const engine = MotionSyncCriEngine.initialize(core);
    expect(engine.version).toEqual({ major: 1, minor: 2, patch: 3, raw: (1 << 24) | (2 << 16) | 3 });
    const model = fakeModel(["ParamAngleX", "ParamMouthForm", "ParamMouthOpenY"]);
    const sync = CubismMotionSync.create(model, parseMotionSyncJson(KEI_LIKE), 48000);
    expect(sync.processorCount).toBe(1);
    expect(core.calls.filter((c) => c.startsWith("mapping(")).length).toBe(6);
    expect(core.calls).toContain("create(count=6,rate=48000)");

    // Silence → no writes
    sync.setSoundBuffer(0, Array.from(tone(50, 0)), 0);
    let writes = sync.updateParameters(1 / 30);
    expect(writes.map((w) => `${w.id}=${w.value.toFixed(2)}`)).toEqual(["ParamMouthForm=0.00", "ParamMouthOpenY=0.00"]);
    expect(core.calls.some((c) => c.startsWith("analyze(") && c.includes("blend=0.5") && c.includes("smooth=60"))).toBe(true);

    // Loud audio → mouth opens (smoothing keeps the first value at 75 %).
    const loud = Array.from(tone(200, 0.5));
    sync.setSoundBuffer(0, loud, 0);
    writes = sync.updateParameters(1 / 30);
    const open = writes.find((w) => w.id === "ParamMouthOpenY")!;
    expect(open.value).toBeGreaterThan(0.5);
    expect(model.values[2]).toBeCloseTo(open.value);
    expect(sync.getLastTotalProcessedCount(0)).toBeGreaterThan(0);
    expect(sync.getLastTotalProcessedCount(0) % 480).toBe(0);

    sync.release();
    expect(core.calls).toContain("delete");
  });

  it("MotionSyncLipSync feeds played PCM, exposes LipSyncOutput + parameter writes, and resets on interrupt", async () => {
    const core = createFakeCore();
    const model = fakeModel(["ParamMouthForm", "ParamMouthOpenY"]);
    let t = 0;
    const ls = await MotionSyncLipSync.create({ core, motionSync: KEI_LIKE, model, clock: () => t });
    expect(ls.engine).toBe("motionsync");
    for (let i = 0; i < 10; i++) { ls.push(createFrame(tone(10, 0.5), 48000, t)); t += 10; }
    t += 16;
    const out = ls.sample();
    expect(out.mouthOpenY).toBeGreaterThan(0.3);
    expect(out.mouthForm).toBeGreaterThan(0);
    expect(ls.getParameterWrites().map((w) => w.id)).toEqual(["ParamMouthForm", "ParamMouthOpenY"]);
    expect(model.values[1]).toBeGreaterThan(0.3);
    // 24 kHz input is resampled to the Core rate.
    ls.push(createFrame(tone(10, 0.5, 24000), 24000, t));
    ls.reset();
    expect(ls.sample().mouthOpenY).toBe(0);
    expect(ls.getParameterWrites().length).toBe(2);
    ls.dispose();
  });

  it("throws BLOCKED_BY_MOTIONSYNC_CORE when no Core can be loaded", async () => {
    const model = fakeModel(["ParamMouthOpenY"]);
    await expect(MotionSyncLipSync.create({ motionSync: KEI_LIKE, model, coreUrl: "/nowhere/live2dcubismmotionsynccore.min.js" })).rejects.toBeInstanceOf(MotionSyncUnavailableError);
    try {
      await MotionSyncLipSync.create({ motionSync: KEI_LIKE, model });
    } catch (e) {
      expect((e as MotionSyncUnavailableError).code).toBe("BLOCKED_BY_MOTIONSYNC_CORE");
      expect((e as Error).message).toContain("live2d.com/en/sdk/download/motionsync");
    }
  });
});
