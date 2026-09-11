// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "./App.js";
import { DEFAULT_SETTINGS, saveSettings } from "./state/settings.js";

vi.mock("./integrations/registry.js", () => ({ loadPersonas: async () => ({ personas: [] }), loadCharacterEntries: async () => ({ entries: [] }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("passes strict_local to the OAuth return route before any cloud request", async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  sessionStorage.clear(); history.replaceState(null, "", "/#zoom_oauth=pending");
  saveSettings({ ...DEFAULT_SETTINGS, privacyMode: "strict_local", engine: "local", brokerUrl: "https://broker.test", agentUrl: "wss://agent.test" });
  sessionStorage.setItem("rcai.zoom.pending", JSON.stringify({ base: "https://broker.test", verifier: "stored-test-verifier", meetingUrl: "https://zoom.us/j/123" }));
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<App />));
    expect(fetcher).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Zoomと連携するには、設定でクラウドの利用を有効にしてください");
    expect(sessionStorage.getItem("rcai.zoom.pending")).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); sessionStorage.clear(); history.replaceState(null, "", "/");
  }
});
