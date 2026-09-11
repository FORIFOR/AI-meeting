// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvatarProvider, CharacterDefinition } from "@rcai/avatar-core";

const character = {
  manifest: { id: "vrm-sample", name: "VRM Sample", renderer: "vrm", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "gentle", voiceProfiles: [] },
  baseUrl: "/characters/vrm-sample", model: "model/avatar.vrm", expressions: {}, motions: {}, voice: { characterId: "vrm-sample", voices: {} },
} satisfies CharacterDefinition;

function provider(id: string) {
  return { id, prepare: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    pushAudio: vi.fn(), setState: vi.fn(), setEmotion: vi.fn(), performGesture: vi.fn(), setGaze: vi.fn(), interrupt: vi.fn() } satisfies AvatarProvider;
}
let vrm = provider("vrm"), canvas = provider("canvas");
let importFailure = false, modelFailure = false;
const vrmImported = vi.fn(), vrmCreated = vi.fn(), canvasCreated = vi.fn(), cloudImported = vi.fn();

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vrm = provider("vrm"); canvas = provider("canvas");
  importFailure = false; modelFailure = false;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((kind: string) => kind === "webgl2" ? { isContextLost: () => false } : null) as typeof HTMLCanvasElement.prototype.getContext);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("unexpected network request"); }));
  vi.doMock("@rcai/avatar-vrm", () => {
    vrmImported();
    if (importFailure) throw new Error("VRM chunk failed to load");
    return { VRMAvatarProvider: class {
      constructor(options: unknown) {
        vrmCreated(options);
        if (modelFailure) vrm.prepare.mockRejectedValue(new Error("VRM asset missing"));
        return vrm;
      }
    } };
  });
  vi.doMock("@rcai/avatar-canvas", () => ({ CanvasAvatarProvider: class {
    constructor(options: unknown) { canvasCreated(options); return canvas; }
  } }));
  for (const name of ["@rcai/avatar-anam", "@rcai/avatar-liveavatar", "@rcai/avatar-tavus"]) {
    vi.doMock(name, () => { cloudImported(name); throw new Error("unexpected cloud renderer import"); });
  }
});

afterEach(() => {
  expect(cloudImported).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function create(extra: Partial<import("./registry.js").AvatarFactoryOptions> = {}) {
  const { createAvatarProvider } = await import("./registry.js");
  const onFallback = vi.fn();
  const container = document.createElement("div");
  const avatar = await createAvatarProvider("vrm", { container, brokerUrl: "https://broker.invalid", characterId: character.manifest.id, characterName: character.manifest.name, quality: "lightweight", onFallback, ...extra });
  return { avatar, onFallback, container };
}

describe("VRM stays on local rendering paths", () => {
  it("keeps a successful VRM and forwards strict-local options without creating fallback", async () => {
    const { avatar, onFallback, container } = await create({ privacyMode: "strict_local" });
    await avatar.prepare(character); await avatar.start();
    expect(avatar.id).toBe("vrm");
    expect(vrmCreated).toHaveBeenCalledWith({ container, privacyMode: "strict_local" });
    expect(canvasCreated).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    await avatar.stop();
  });

  it("uses a clearly labelled simple canvas when WebGL is unavailable without importing VRM", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const { avatar, onFallback } = await create();
    await avatar.prepare(character); await avatar.start();
    expect(vrmImported).not.toHaveBeenCalled();
    expect(avatar.id).toBe("canvas");
    expect(character.manifest.renderer).toBe("vrm");
    expect(onFallback).toHaveBeenCalledExactlyOnceWith("vrm_webgl_unavailable");
    expect(canvasCreated).toHaveBeenCalledWith(expect.objectContaining({ label: "VRM Sample · 簡易表示" }));
    expect(canvasCreated.mock.calls[0]![0]).not.toHaveProperty("characterId");
    await avatar.stop();
  });

  it("falls back locally if the VRM renderer chunk cannot load", async () => {
    importFailure = true;
    const { avatar, onFallback } = await create();
    expect(avatar.id).toBe("canvas");
    expect(vrmCreated).not.toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledExactlyOnceWith("vrm_renderer_unavailable");
    await avatar.stop();
  });

  it("exposes requested VRM and actual canvas separately after the model fails", async () => {
    modelFailure = true;
    const { avatar, onFallback } = await create();
    expect(avatar.id).toBe("vrm");
    await avatar.prepare(character);
    expect({ requested: character.manifest.renderer, actual: avatar.id }).toEqual({ requested: "vrm", actual: "canvas" });
    expect(vrm.stop).toHaveBeenCalled();
    expect(onFallback).toHaveBeenCalledExactlyOnceWith("vrm_model_unavailable");
    expect(canvasCreated).toHaveBeenCalledOnce();
    await avatar.start();
    expect(canvas.start).toHaveBeenCalledOnce();
    await avatar.stop();
  });

  it.each(["privacy", "oss"])("does not import a paid renderer for a saved natural preference under %s restrictions", async (mode) => {
    if (mode === "oss") vi.stubEnv("VITE_RCAI_OSS", "true");
    modelFailure = true;
    const { avatar } = await create({ quality: "natural", privacyMode: mode === "privacy" ? "strict_local" : "default" });
    await avatar.prepare(character);
    expect(avatar.id).toBe("canvas");
    await avatar.stop();
  });
});
