/**
 * `.motionsync3.json` parser — a plain-JSON port of CubismMotionSyncDataJson / CubismMotionSyncData
 * (Live2D Open Software License; reference/CubismWebMotionSyncComponents/Framework/src/cubismmotionsyncdata*.ts).
 * csmVector/csmString/CubismJson are replaced with arrays, strings and JSON.parse.
 */
export interface MotionSyncCubismParameter {
  name: string;
  id: string;
  min: number;
  max: number;
  damper: number;
  smooth: number;
}

export interface MotionSyncAudioParameter {
  name: string;
  id: string;
  min: number;
  max: number;
  scale: number;
  enabled: boolean;
}

export interface MotionSyncMapping {
  type: "Shape" | "Unknown";
  audioId: string;
  targets: { id: string; value: number }[];
}

export interface MotionSyncSetting {
  id: string;
  analysisType: "CRI" | "Unknown";
  useCase: "Mouth" | "Unknown";
  cubismParameters: MotionSyncCubismParameter[];
  audioParameters: MotionSyncAudioParameter[];
  mappings: MotionSyncMapping[];
  blendRatio: number;
  smoothing: number;
  /** analysis fps */
  sampleRate: number;
}

export interface MotionSyncData {
  version: number;
  dictionary: { id: string; name: string }[];
  settings: MotionSyncSetting[];
}

/** One entry of the native mapping-info struct list handed to the Core. */
export interface MappingInfo {
  audioParameterId: string;
  modelParameterIds: string[];
  modelParameterValues: number[];
  scale: number;
  enabled: boolean;
}

interface RawJson {
  Version?: number;
  Meta?: { SettingCount?: number; Dictionary?: { Id: string; Name: string }[] };
  Settings?: {
    Id: string;
    AnalysisType?: string;
    UseCase?: string;
    CubismParameters?: { Name?: string; Id: string; Min?: number; Max?: number; Damper?: number; Smooth?: number }[];
    AudioParameters?: { Name?: string; Id: string; Min?: number; Max?: number; Scale?: number; Enabled?: boolean }[];
    Mappings?: { Type?: string; Id: string; Targets?: { Id: string; Value: number }[] }[];
    PostProcessing?: { BlendRatio?: number; Smoothing?: number; SampleRate?: number };
  }[];
}

export class MotionSyncDataError extends Error {}

export function parseMotionSyncJson(input: string | object): MotionSyncData {
  const raw = (typeof input === "string" ? JSON.parse(input) : input) as RawJson;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.Settings)) throw new MotionSyncDataError("motionsync3.json: Settings missing");
  const count = raw.Meta?.SettingCount ?? raw.Settings.length;
  const settings: MotionSyncSetting[] = raw.Settings.slice(0, count).map((s) => {
    const cubismParameters = (s.CubismParameters ?? []).map((p) => ({ name: p.Name ?? p.Id, id: p.Id, min: p.Min ?? 0, max: p.Max ?? 1, damper: p.Damper ?? 0, smooth: p.Smooth ?? 0 }));
    const audioParameters = (s.AudioParameters ?? []).map((p) => ({ name: p.Name ?? p.Id, id: p.Id, min: p.Min ?? 0, max: p.Max ?? 1, scale: p.Scale ?? 1, enabled: p.Enabled ?? true }));
    const mappings: MotionSyncMapping[] = (s.Mappings ?? []).map((m) => ({
      type: m.Type === "Shape" ? "Shape" : "Unknown",
      audioId: m.Id,
      // The framework reads exactly cubismParameters.length targets per mapping.
      targets: cubismParameters.map((_, i) => ({ id: m.Targets?.[i]?.Id ?? cubismParameters[i]!.id, value: m.Targets?.[i]?.Value ?? 0 })),
    }));
    const post = s.PostProcessing ?? {};
    return {
      id: s.Id,
      analysisType: s.AnalysisType === "CRI" ? "CRI" : "Unknown",
      useCase: s.UseCase === "Mouth" ? "Mouth" : "Unknown",
      cubismParameters,
      audioParameters,
      mappings,
      blendRatio: post.BlendRatio ?? 0,
      smoothing: post.Smoothing ?? 1,
      sampleRate: post.SampleRate ?? 30,
    };
  });
  return {
    version: raw.Version ?? 1,
    dictionary: (raw.Meta?.Dictionary ?? []).map((d) => ({ id: d.Id, name: d.Name })),
    settings,
  };
}

/** Port of CubismMotionSyncData.getMappingInfoList: one MappingInfo per audio parameter. */
export function buildMappingInfoList(setting: MotionSyncSetting): MappingInfo[] {
  return setting.audioParameters.map((ap) => {
    const mapping = setting.mappings.find((m) => m.audioId === ap.id);
    const ids: string[] = [];
    const values: number[] = [];
    if (mapping) {
      for (const t of mapping.targets) {
        ids.push(t.id);
        values.push(t.value);
      }
    }
    return { audioParameterId: ap.id, modelParameterIds: ids, modelParameterValues: values, scale: ap.scale, enabled: ap.enabled };
  });
}
