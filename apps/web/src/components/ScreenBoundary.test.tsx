// @vitest-environment jsdom
import { act, lazy } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ScreenBoundary } from "./ScreenBoundary.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("keeps a way home when a screen download fails and recovers on navigation", async () => {
  const BrokenScreen = lazy(() => Promise.reject(new Error("Failed to fetch screen")));
  const host = document.createElement("div");
  const root = createRoot(host);
  const onHome = vi.fn();
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await act(async () => root.render(<ScreenBoundary key="meeting" onHome={onHome}><BrokenScreen /></ScreenBoundary>));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("画面を読み込めませんでした");
    const back = Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "ホームへ戻る")!;
    await act(async () => back.click());
    expect(onHome).toHaveBeenCalledOnce();
    await act(async () => root.render(<ScreenBoundary key="home" onHome={onHome}><main>ホーム</main></ScreenBoundary>));
    expect(host.textContent).toBe("ホーム");
  } finally {
    await act(async () => root.unmount());
    logged.mockRestore();
  }
});
