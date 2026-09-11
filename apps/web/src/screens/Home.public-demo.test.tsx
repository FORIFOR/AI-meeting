// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Home, type HomeProps } from "./Home.js";
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

it("offers the API-free demo without promising hosted conversation or credits", async () => {
  const host = document.createElement("div"), root = createRoot(host), talk = vi.fn(), meeting = vi.fn();
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const props = {
    settings: { characterId: "yui", privacyMode: "default", engine: "google" }, dispatch: vi.fn(), personas: [],
    characters: [{ id: "yui", name: "Yui", renderer: "live2d" }], broker: { ok: true, providers: { openai: false, google: false }, publicAccess: { mode: "demo_only" } },
    agent: null, recent: null, onContinue: vi.fn(), onTalk: talk, onCharacter: vi.fn(), onSettings: vi.fn(), onMeeting: meeting,
  } as unknown as HomeProps;
  try {
    await act(async () => root.render(<Home {...props} />));
    expect(host.querySelector('a[href="/vrm-demo.html"]')).not.toBeNull();
    expect(host.textContent).toContain("公開デモはAPIキー不要");
    expect(host.textContent).not.toContain("初期付与");
    expect(host.textContent).not.toContain("残りのクレジット");
    expect(Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("会議に呼ぶ"))?.disabled).toBe(true);
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(meeting).not.toHaveBeenCalled(); expect(talk).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
