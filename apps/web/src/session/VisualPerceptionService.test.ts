import { describe, expect, it } from "vitest";
import { mediaPipeErrorMessage } from "./VisualPerceptionService.js";

describe("mediaPipeErrorMessage", () => {
  it("turns a browser Event rejection into a useful fallback", () => {
    expect(mediaPipeErrorMessage({ type: "error" })).toBe("モデルまたはWASMの読み込みに失敗しました");
    expect(mediaPipeErrorMessage({ type: "error" })).not.toContain("[object Event]");
  });

  it("keeps actionable resource status details", () => {
    expect(mediaPipeErrorMessage({ type: "error", target: { status: 404, statusText: "Not Found" } })).toBe("HTTP 404 · Not Found");
    expect(mediaPipeErrorMessage(new Error("WebGL unavailable"))).toBe("WebGL unavailable");
  });
});
