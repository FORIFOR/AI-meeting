import { describe, expect, it, vi } from "vitest";
import { createAvatarProvider, webglAvailable } from "./registry.js";

/**
 * A meeting vendor runs the bot page in its own browser. Attendee's webpage streamer launches Chrome
 * with `--disable-gpu` and no `--enable-unsafe-swiftshader`, which in current Chrome means no WebGL
 * context at all (measured both ways — see docs/commercial-gate.md). Live2D needs a visible 2D
 * fallback there so the bot is not audible-only in the participant tile.
 */
describe("avatar renderers that need WebGL", () => {
  const container = { appendChild: () => {} } as unknown as HTMLElement;

  it("uses the visible 2D fallback for Live2D and still rejects VRM", async () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    expect(webglAvailable()).toBe(false);
    const fallback = await createAvatarProvider("live2d", { container, brokerUrl: "http://b", characterId: "yui", characterName: "Yui" });
    expect(fallback.id).toBe("canvas");
    await expect(createAvatarProvider("vrm", { container, brokerUrl: "http://b" })).rejects.toThrow(/BLOCKED_BY_NO_WEBGL/);
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

  it("assumes availability where there is no DOM at all (node, tests)", () => {
    vi.stubGlobal("document", undefined);
    expect(webglAvailable()).toBe(true);
    vi.unstubAllGlobals();
  });
});
