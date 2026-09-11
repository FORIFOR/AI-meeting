// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { VRMUtils } from "@pixiv/three-vrm";
import type { CharacterDefinition } from "@rcai/avatar-core";
import { VRMAvatarProvider } from "./VRMAvatarProvider.js";

const mocks = vi.hoisted(() => ({ parse: vi.fn(), renderers: [] as Array<{
  dispose: ReturnType<typeof vi.fn>; forceContextLoss: ReturnType<typeof vi.fn>;
}>, managers: [] as THREE.LoadingManager[], json: {} as Record<string, unknown> }));

vi.mock("three", async (original) => {
  const actual = await original<typeof THREE>();
  return { ...actual, WebGLRenderer: class {
    domElement = document.createElement("canvas");
    setPixelRatio = vi.fn(); setSize = vi.fn(); setClearColor = vi.fn(); render = vi.fn();
    dispose = vi.fn(); forceContextLoss = vi.fn();
    constructor() { mocks.renderers.push(this); }
  } };
});
vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({ GLTFLoader: class {
  private plugins: Array<(parser: { json: Record<string, unknown> }) => unknown> = [];
  register(plugin: (parser: { json: Record<string, unknown> }) => unknown) { this.plugins.push(plugin); }
  async parseAsync(...args: unknown[]) {
    for (const plugin of this.plugins) plugin({ json: mocks.json });
    return mocks.parse(...args);
  }
  constructor(manager: THREE.LoadingManager) { mocks.managers.push(manager); }
} }));
vi.mock("@pixiv/three-vrm", () => ({
  VRMLoaderPlugin: vi.fn(),
  VRMUtils: { deepDispose: vi.fn(), removeUnnecessaryVertices: vi.fn(),
    combineSkeletons: vi.fn(), combineMorphs: vi.fn(), rotateVRM0: vi.fn() },
}));

const character: CharacterDefinition = {
  manifest: { id: "sample", name: "Sample", renderer: "vrm", defaultPersona: "free", supportedLanguages: ["ja"],
    motionProfile: "default", voiceProfiles: [] },
  baseUrl: "/models", model: "sample.vrm", expressions: {}, motions: {}, voice: { characterId: "sample", voices: {} },
};
function gltf() {
  const scene = new THREE.Group();
  return { scene, userData: { vrm: { scene, humanoid: { getNormalizedBoneNode: () => null },
    expressionManager: null, lookAt: {}, update: vi.fn() } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
const response = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) });
const providers: VRMAvatarProvider[] = [];
function provider(options: Partial<ConstructorParameters<typeof VRMAvatarProvider>[0]> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  const avatar = new VRMAvatarProvider({ container, scheduler: "manual", ...options });
  providers.push(avatar);
  return { avatar, container };
}

beforeEach(() => {
  vi.clearAllMocks(); mocks.renderers.length = 0; mocks.managers.length = 0; mocks.json = {};
  vi.stubGlobal("fetch", vi.fn(async () => response()));
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  mocks.parse.mockImplementation(async () => gltf());
});
afterEach(async () => {
  for (const avatar of providers.splice(0)) await avatar.stop();
  document.body.replaceChildren(); vi.unstubAllGlobals();
});

describe("VRM model lifecycle and privacy", () => {
  it("aborts fetch on stop and never parses a late completed download", async () => {
    const request = deferred<ReturnType<typeof response>>();
    vi.mocked(fetch).mockImplementation(() => request.promise as unknown as Promise<Response>);
    const { avatar, container } = provider();
    const prepared = avatar.prepare(character);
    const rejected = expect(prepared).rejects.toThrow("VRM_MODEL_LOAD_CANCELLED");
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    await avatar.stop();
    expect(signal.aborted).toBe(true);
    request.resolve(response()); await rejected;
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    expect(mocks.renderers[0]!.dispose).toHaveBeenCalledOnce();
    expect(mocks.renderers[0]!.forceContextLoss).toHaveBeenCalledOnce();
  });

  it("disposes a parsed model that arrives after stop", async () => {
    const parsed = deferred<ReturnType<typeof gltf>>(); mocks.parse.mockReturnValue(parsed.promise);
    const { avatar } = provider();
    const prepared = avatar.prepare(character);
    const rejected = expect(prepared).rejects.toThrow("VRM_MODEL_LOAD_CANCELLED");
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledOnce());
    await avatar.stop();
    const late = gltf(); parsed.resolve(late); await rejected;
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(late.scene);
    expect(avatar.getPose()).toBeNull();
  });

  it("keeps the replacement model when an older prepare resolves", async () => {
    const parsed = deferred<ReturnType<typeof gltf>>(); mocks.parse.mockReturnValueOnce(parsed.promise);
    const { avatar, container } = provider();
    const old = avatar.prepare(character);
    const rejected = expect(old).rejects.toThrow("VRM_MODEL_LOAD_CANCELLED");
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledOnce());
    await avatar.prepare(character);
    const late = gltf(); parsed.resolve(late); await rejected;
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(avatar.getPose()).not.toBeNull();
    expect(mocks.renderers[1]!.dispose).not.toHaveBeenCalled();
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(late.scene);
  });

  it("releases the scene, canvas and renderer on invalid model or optimizer error", async () => {
    const badScene = new THREE.Group(); mocks.parse.mockResolvedValueOnce({ scene: badScene, userData: {} });
    const invalid = provider();
    await expect(invalid.avatar.prepare(character)).rejects.toThrow("VRM_MODEL_INVALID");
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(badScene);
    expect(invalid.container.childElementCount).toBe(0);
    const bad = gltf(); mocks.parse.mockResolvedValueOnce(bad);
    vi.mocked(VRMUtils.combineMorphs).mockImplementationOnce(() => { throw new Error("optimizer failed"); });
    const failed = provider();
    await expect(failed.avatar.prepare(character)).rejects.toThrow("optimizer failed");
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(bad.scene);
    expect(failed.container.childElementCount).toBe(0);
    for (const renderer of mocks.renderers) expect(renderer.dispose).toHaveBeenCalledOnce();
  });

  it("rejects strict-local remote models before fetch or WebGL allocation", async () => {
    const { avatar } = provider({ privacyMode: "strict_local", modelUrl: "https://outside.invalid/model.vrm" });
    await expect(avatar.prepare(character)).rejects.toThrow("VRM_REMOTE_ASSET_BLOCKED_BY_PRIVACY");
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.renderers).toHaveLength(0);
  });

  it("rejects and disposes a model when GLTF parsing resolves despite a failed texture", async () => {
    const missingTexture = gltf();
    mocks.parse.mockImplementationOnce(async () => {
      mocks.managers[0]!.itemError("blob:http://localhost/failed-texture");
      return missingTexture; // Mirrors GLTFLoader's texture catch -> null behavior.
    });
    const { avatar, container } = provider();
    await expect(avatar.prepare(character)).rejects.toThrow("VRM_MODEL_RESOURCE_FAILED");
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(missingTexture.scene);
    expect(container.childElementCount).toBe(0);
    expect(avatar.getPose()).toBeNull();
    expect(avatar.getLipSyncDiagnostics().state).toBe("disposed");
    expect(mocks.renderers[0]!.forceContextLoss).toHaveBeenCalledOnce();
    await avatar.prepare(character); // A failed previous model cannot poison a later valid load.
    expect(avatar.getPose()).not.toBeNull();
  });

  it("rejects a privacy-blocked texture even when the parser swallows the URL rejection", async () => {
    const missingTexture = gltf();
    mocks.parse.mockImplementationOnce(async () => {
      try { mocks.managers[0]!.resolveURL("https://outside.invalid/face.png"); }
      catch { /* GLTF texture loading may catch URL-modifier errors too. */ }
      return missingTexture;
    });
    const { avatar, container } = provider({ privacyMode: "strict_local" });
    await expect(avatar.prepare(character)).rejects.toThrow("VRM_MODEL_RESOURCE_FAILED");
    expect(VRMUtils.deepDispose).toHaveBeenCalledWith(missingTexture.scene);
    expect(container.childElementCount).toBe(0);
    expect(fetch).toHaveBeenCalledOnce(); // Only the same-origin model download.
  });

  it.each([
    { images: [{ uri: "/redirect-to-external.png" }] },
    { buffers: [{ uri: "/redirect-to-external.bin" }] },
    { images: [{ uri: "https://outside.invalid/face.png" }] },
    { images: [{ uri: "blob:http://localhost/caller-texture" }] },
  ])("blocks declared dependent resource URIs before the strict-local parser can fetch them: %j", async (json) => {
    mocks.json = json;
    const { avatar, container } = provider({ privacyMode: "strict_local" });
    await expect(avatar.prepare(character)).rejects.toThrow("VRM_SELF_CONTAINED_MODEL_REQUIRED");
    expect(fetch).toHaveBeenCalledOnce(); // Only the same-origin model, with redirect:error.
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });

  it("accepts strict-local embedded bufferViews and data URIs", async () => {
    mocks.json = { buffers: [{ byteLength: 4 }, { uri: "data:application/octet-stream;base64,AAAA" }],
      images: [{ bufferView: 0 }, { uri: "data:image/png;base64,AAAA" }] };
    const modelURL = `blob:${location.origin}/caller-model`;
    const { avatar } = provider({ privacyMode: "strict_local", modelUrl: modelURL });
    await avatar.prepare(character);
    expect(avatar.getPose()).not.toBeNull();
    await avatar.stop();
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(modelURL);
  });

  it("releases failed loader-generated image URLs without revoking caller-owned texture URLs", async () => {
    const supplied = "blob:http://localhost/caller-texture", generated = "blob:http://localhost/generated-texture";
    mocks.json = { images: [{ uri: supplied }, { bufferView: 0 }] };
    mocks.parse.mockImplementationOnce(async () => {
      const manager = mocks.managers[0]!;
      manager.resolveURL(supplied); manager.resolveURL(generated); manager.itemError(generated);
      return gltf();
    });
    const { avatar } = provider();
    await expect(avatar.prepare(character)).rejects.toThrow("VRM_MODEL_RESOURCE_FAILED");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(generated);
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(supplied);
  });

  it("revokes generated images at stop and also refuses/revokes images created by a late parse", async () => {
    const parsed = deferred<ReturnType<typeof gltf>>();
    const generated = "blob:http://localhost/generated-before-stop", late = "blob:http://localhost/generated-after-stop";
    mocks.parse.mockImplementationOnce(() => { mocks.managers[0]!.resolveURL(generated); return parsed.promise; });
    const { avatar } = provider();
    const prepared = expect(avatar.prepare(character)).rejects.toThrow("VRM_MODEL_LOAD_CANCELLED");
    await vi.waitFor(() => expect(mocks.parse).toHaveBeenCalledOnce());
    await avatar.stop();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(generated);
    expect(() => mocks.managers[0]!.resolveURL(late)).toThrow("VRM_MODEL_LOAD_CANCELLED");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(late);
    parsed.resolve(gltf()); await prepared;
  });

  it("releases tracked generated URLs after a successful parse too", async () => {
    const generated = "blob:http://localhost/generated-success";
    mocks.parse.mockImplementationOnce(async () => { mocks.managers[0]!.resolveURL(generated); return gltf(); });
    const { avatar } = provider();
    await avatar.prepare(character);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(generated);
    expect(avatar.getPose()).not.toBeNull();
  });

  it("rejects remote embedded resources and redirects while allowing same-origin and embedded bytes", async () => {
    const { avatar } = provider({ privacyMode: "strict_local" });
    await avatar.prepare(character);
    expect(vi.mocked(fetch).mock.calls[0]![1]!.redirect).toBe("error");
    const manager = mocks.managers[0]!;
    expect(() => manager.resolveURL("https://outside.invalid/face.png")).toThrow("VRM_REMOTE_ASSET_BLOCKED_BY_PRIVACY");
    expect(manager.resolveURL("/models/face.png")).toBe("/models/face.png");
    expect(manager.resolveURL("data:image/png;base64,AA==")).toBe("data:image/png;base64,AA==");
  });

  it("clears speech and gesture immediately on interrupt and rejects old PCM in the next state", async () => {
    const { avatar } = provider(); await avatar.prepare(character); await avatar.start();
    avatar.setState("SPEAKING"); avatar.performGesture("wave", 1);
    avatar.pushAudio({ data: new Float32Array(960).fill(0.2), sampleRate: 48000, channels: 1, timestamp: 1 });
    avatar.tick(); expect(avatar.getParams().mouthOpenY).toBeGreaterThan(0);
    avatar.interrupt(); expect(avatar.getParams().mouthOpenY).toBe(0);
    avatar.pushAudio({ data: new Float32Array(960).fill(0.2), sampleRate: 48000, channels: 1, timestamp: 2 });
    avatar.setState("LISTENING"); avatar.setState("SPEAKING"); avatar.tick();
    expect(avatar.getParams().mouthOpenY).toBe(0);
    const pose = avatar.getPose()!;
    for (const vowel of ["aa", "ih", "ee", "ou", "oh"]) expect(pose.expressions[vowel]).toBe(0);
  });
});
