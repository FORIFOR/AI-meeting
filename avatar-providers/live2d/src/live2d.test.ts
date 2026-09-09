import { describe, expect, it } from "vitest";
import { neutralParams } from "@rcai/avatar-core";
import { OFFICIAL_CUBISM_CORE_CDN, resolveCoreUrl } from "./core.js";
import { buildParamTable, resolveParamIds, toLive2DValues } from "./mapping.js";

describe("resolveCoreUrl", () => {
  it("prefers option, then vendored file, then CDN", async () => {
    expect((await resolveCoreUrl({ coreUrl: "/x.js", head: async () => true })).source).toBe("option");
    expect(await resolveCoreUrl({ head: async () => true })).toEqual({ url: "/vendor/live2d/live2dcubismcore.min.js", source: "vendor" });
    expect(await resolveCoreUrl({ head: async () => false })).toEqual({ url: OFFICIAL_CUBISM_CORE_CDN, source: "cdn" });
  });
});

describe("toLive2DValues", () => {
  const std = buildParamTable({
    ids: ["ParamAngleX", "ParamAngleY", "ParamEyeLOpen", "ParamEyeROpen", "ParamMouthOpenY", "ParamMouthForm", "ParamBreath"],
    minimumValues: new Float32Array([-30, -30, 0, 0, 0, -1, 0]),
    maximumValues: new Float32Array([30, 30, 1, 1, 1, 1, 1]),
  });
  it("maps canonical params to standard ids, clamps to model ranges and skips unknown params", () => {
    const p = { ...neutralParams(), angleX: 45, eyeLOpen: 1.4, mouthOpenY: 0.7, mouthForm: 0.2, armL: 1 };
    const out = new Map(toLive2DValues(p, resolveParamIds(), std));
    expect(out.get("ParamAngleX")).toBe(30);
    expect(out.get("ParamEyeLOpen")).toBe(1);
    expect(out.get("ParamMouthOpenY")).toBeCloseTo(0.7);
    expect(out.has("ParamArmLA")).toBe(false);
    expect(out.size).toBe(7);
  });
  it("derives visemes for models without ParamMouthOpenY (Mao-style ParamA/I/U/E/O + MouthUp/Down)", () => {
    const mao = buildParamTable({
      ids: ["ParamAngleX", "ParamA", "ParamI", "ParamU", "ParamE", "ParamO", "ParamMouthUp", "ParamMouthDown"],
      minimumValues: new Float32Array([-30, 0, 0, 0, 0, 0, 0, 0]),
      maximumValues: new Float32Array([30, 1, 1, 1, 1, 1, 1, 1]),
    });
    const ids = resolveParamIds({ mouthOpenY: "ParamA", mouthForm: "ParamMouthUp" });
    const wide = new Map(toLive2DValues({ ...neutralParams(), mouthOpenY: 0.8, mouthForm: 0.9 }, ids, mao));
    expect(wide.get("ParamI")).toBeCloseTo(0.72);
    expect(wide.get("ParamU")).toBe(0);
    expect(wide.get("ParamMouthUp")).toBeCloseTo(0.9);
    expect(wide.get("ParamMouthDown")).toBe(0);
    const narrow = new Map(toLive2DValues({ ...neutralParams(), mouthOpenY: 0.8, mouthForm: -0.8 }, ids, mao));
    expect(narrow.get("ParamU")).toBeGreaterThan(0.4);
    expect(narrow.get("ParamI")).toBe(0);
    expect(narrow.get("ParamMouthDown")).toBeCloseTo(0.8);
    const closed = new Map(toLive2DValues(neutralParams(), ids, mao));
    expect(closed.get("ParamA")).toBe(0);
  });
});

describe("inkFor", () => {
  it("puts dark ink on a pack's light background and white on anything dark or unparseable", async () => {
    const { inkFor } = await import("./live2dAvatar.js");
    expect(inkFor("#f6f1ea")).toBe("rgba(0, 0, 0, 0.62)");
    expect(inkFor("#fff")).toBe("rgba(0, 0, 0, 0.62)");
    expect(inkFor("#1a1a1a")).toBe("#ffffff");
    expect(inkFor("linear-gradient(#000, #fff)")).toBe("#ffffff");
  });
});


describe("meeting render budget", () => {
  it("bounds a large retina camera framebuffer without changing its aspect ratio", async () => {
    const { renderResolution } = await import("./live2dAvatar.js");
    for (const [w, h] of [[1920, 1080], [1080, 1920], [2560, 1440]]) {
      const resolution = renderResolution(w!, h!, 2, true);
      expect(Math.max(w!, h!) * resolution).toBeCloseTo(640);
      expect((w! * resolution) / (h! * resolution)).toBeCloseTo(w! / h!);
      expect(w! * h! * resolution ** 2).toBeLessThanOrEqual(640 ** 2);
    }
    expect(renderResolution(320, 240, 2, true)).toBe(1);
    expect(renderResolution(1920, 1080, 2, false)).toBe(2);
  });
});
