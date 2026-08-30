import { LIVE2D_PARAM_IDS, PARAM_NAMES, type AvatarParams, type ParamName } from "@rcai/avatar-core";

export interface Live2DParamInfo {
  index: number;
  min: number;
  max: number;
}

export type ParamTable = Map<string, Live2DParamInfo>;

/** Resolve canonical → Live2D id map with character overrides. */
export function resolveParamIds(overrides?: Partial<Record<ParamName, string>>): Record<ParamName, string> {
  return { ...LIVE2D_PARAM_IDS, ...(overrides ?? {}) } as Record<ParamName, string>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Map canonical params to (id, value) pairs, clamped to the model's own ranges.
 * Params the model does not have are skipped (never creates phantom parameters).
 * Models that use ParamA/I/U/E/O instead of ParamMouthOpenY get a viseme approximation.
 */
export function toLive2DValues(params: AvatarParams, ids: Record<ParamName, string>, table: ParamTable): [string, number][] {
  const out: [string, number][] = [];
  for (const name of PARAM_NAMES) {
    const id = ids[name];
    const info = table.get(id);
    if (!info) continue;
    let v = params[name];
    if (name === "eyeLOpen" || name === "eyeROpen") v = Math.min(v, info.max); // canonical 1.5 max vs model max
    out.push([id, clamp(v, info.min, info.max)]);
  }
  // Viseme fallback for mouths without MouthOpenY (e.g. Live2D sample "Mao").
  const mouthId = ids.mouthOpenY;
  if (mouthId === "ParamA" || (!table.has("ParamMouthOpenY") && table.has("ParamA"))) {
    const open = clamp(params.mouthOpenY, 0, 1);
    const form = clamp(params.mouthForm, -1, 1);
    const wide = Math.max(0, form);
    const narrow = Math.max(0, -form);
    const set = (id: string, v: number) => {
      const info = table.get(id);
      if (info) {
        const idx = out.findIndex(([k]) => k === id);
        const val = clamp(v, info.min, info.max);
        if (idx >= 0) out[idx] = [id, val];
        else out.push([id, val]);
      }
    };
    set("ParamA", open * (1 - wide * 0.6 - narrow * 0.5));
    set("ParamI", open * wide);
    set("ParamE", open * wide * 0.4);
    set("ParamU", open * narrow * 0.8);
    set("ParamO", open * narrow * 0.5);
  }
  // Smile/frown for mouths that split form into MouthUp/MouthDown.
  if (ids.mouthForm === "ParamMouthUp" && table.has("ParamMouthDown")) {
    const form = clamp(params.mouthForm, -1, 1);
    const up = table.get("ParamMouthUp")!;
    const down = table.get("ParamMouthDown")!;
    const setOrPush = (id: string, v: number) => {
      const idx = out.findIndex(([k]) => k === id);
      if (idx >= 0) out[idx] = [id, v];
      else out.push([id, v]);
    };
    setOrPush("ParamMouthUp", clamp(Math.max(0, form), up.min, up.max));
    setOrPush("ParamMouthDown", clamp(Math.max(0, -form), down.min, down.max));
  }
  return out;
}

/** Build the parameter table from a Cubism core model (`coreModel.getModel().parameters`). */
export function buildParamTable(parameters: { ids: string[]; minimumValues: ArrayLike<number>; maximumValues: ArrayLike<number> }): ParamTable {
  const table: ParamTable = new Map();
  parameters.ids.forEach((id, index) => {
    table.set(id, { index, min: parameters.minimumValues[index] ?? -1, max: parameters.maximumValues[index] ?? 1 });
  });
  return table;
}
