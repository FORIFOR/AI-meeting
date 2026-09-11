import { describe, expect, it, vi } from "vitest";
import { createAvatarProvider, webglAvailable } from "./registry.js";

// Hosted capability must be measured; browser launch flags alone are not evidence.
describe("avatar renderers that need WebGL", () => {
  const container = { appendChild: () => {} } as unknown as HTMLElement;

  it("uses a visible local fallback for Live2D and VRM without WebGL", async () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(webglAvailable()).toBe(false);
    const fallback = await createAvatarProvider("live2d", { container, brokerUrl: "http://b", characterId: "yui", characterName: "Yui" });
    expect(fallback.id).toBe("canvas");
    const vrmFallback = await createAvatarProvider("vrm", { container, brokerUrl: "http://b" });
    expect(vrmFallback.id).toBe("canvas");
    vi.unstubAllGlobals();
  });

  it("does not block renderers that draw in 2D", async () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    await expect(createAvatarProvider("canvas", { container, brokerUrl: "http://b" })).resolves.toBeTruthy();
    vi.unstubAllGlobals();
  });

  it("treats a real context as available", () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: (k: string) => (k === "webgl2" ? {} : null) }) });
    expect(webglAvailable()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("can force the software renderer for a captured Attendee page", async () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: (k: string) => (k === "webgl2" ? {} : null) }) });
    const forced = await createAvatarProvider("live2d", { container, brokerUrl: "http://b", characterId: "yui", characterName: "Yui", preferCanvas: true });
    expect(forced.id).toBe("canvas");
    vi.unstubAllGlobals();
  });

  it("tries WebGL1 when WebGL2 throws and releases the probe context", () => {
    const loseContext = vi.fn();
    vi.stubGlobal("document", { createElement: () => ({ getContext: (api: string) => {
      if (api === "webgl2") throw new Error("unsupported");
      return { isContextLost: () => false, getExtension: () => ({ loseContext }) };
    } }) });
    expect(webglAvailable()).toBe(true);
    expect(loseContext).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it("does not choose a lost context", () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => ({ isContextLost: () => true }) }) });
    expect(webglAvailable()).toBe(false);
    vi.unstubAllGlobals();
  });

  it("assumes availability where there is no DOM at all (node, tests)", () => {
    vi.stubGlobal("document", undefined);
    expect(webglAvailable()).toBe(true);
    vi.unstubAllGlobals();
  });
});
