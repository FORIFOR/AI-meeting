// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
const attempts = vi.hoisted(() => ({ cloud: 0 }));
vi.mock("@rcai/avatar-anam", () => { attempts.cloud++; throw new Error("renderer chunk unavailable"); });
vi.mock("@rcai/avatar-canvas", () => ({ CanvasAvatarProvider: class {
  id = "canvas";
  stop = vi.fn(async () => {});
} }));
import { createAvatarProvider } from "./registry.js";

describe("optional natural renderer loading", () => {
  it("preview and strict-local stay local without importing the external renderer", async () => {
    const before = attempts.cloud;
    for (const options of [{ framing: "preview" as const }, { privacyMode: "strict_local" as const }]) {
      const avatar = await createAvatarProvider("canvas", { container: document.createElement("div"), brokerUrl: "https://broker.invalid", quality: "natural", ...options });
      expect(avatar.id).toBe("canvas");
      await avatar.stop();
    }
    expect(attempts.cloud).toBe(before);
  });
  it("keeps the prepared local renderer usable when the optional chunk cannot load", async () => {
    const container = document.createElement("div"), onFallback = vi.fn();
    const avatar = await createAvatarProvider("canvas", { container, brokerUrl: "https://broker.invalid", quality: "natural", onFallback });
    expect(avatar.id).toBe("canvas");
    expect(onFallback).toHaveBeenCalledWith("renderer_unavailable");
    expect(container.children).toHaveLength(1);
    await avatar.stop();
    expect(container.children).toHaveLength(0);
  });
});
