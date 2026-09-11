// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { App } from "./App.js";

const screens = vi.hoisted(() => {
  let finishMeetingLoad!: () => void;
  const meetingReady = new Promise<void>((resolve) => { finishMeetingLoad = resolve; });
  return { meetingReady, finishMeetingLoad, meetingRequested: vi.fn(), meetingMounted: vi.fn(), sessionRequested: vi.fn(), settingsRequested: vi.fn(), settingsMounted: vi.fn() };
});

vi.mock("./screens/Meeting.js", async () => {
  screens.meetingRequested();
  await screens.meetingReady;
  return { Meeting: () => { screens.meetingMounted(); return <main>会議画面</main>; } };
});
vi.mock("./screens/Session.js", () => {
  screens.sessionRequested();
  return { Session: () => <main>会話画面</main> };
});
vi.mock("./screens/SettingsScreen.js", () => {
  screens.settingsRequested();
  return { SettingsScreen: () => { screens.settingsMounted(); return <main>設定画面</main>; } };
});
vi.mock("./components/CreditBalance.js", () => ({ CreditBalance: () => null }));
vi.mock("./api/health.js", () => ({
  shouldProbeLocalAgent: () => false,
  probe: async () => ({ broker: null, agent: null, availability: { openai: false, google: false, local: false } }),
}));
vi.mock("./integrations/registry.js", () => ({
  loadPersonas: async () => ({ personas: [] }),
  loadCharacterEntries: async () => ({ entries: [] }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders home without session engines and lets users leave a pending navigation", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(<App />));
    expect(host.textContent).toContain("今日は、誰と話しますか？");
    expect(screens.meetingRequested).not.toHaveBeenCalled();
    expect(screens.sessionRequested).not.toHaveBeenCalled();

    // Keyboard intent warms code without starting meeting resources.
    await act(async () => { button("設定").focus(); await vi.dynamicImportSettled(); });
    expect(screens.settingsRequested).toHaveBeenCalledOnce();
    expect(screens.settingsMounted).not.toHaveBeenCalled();
    expect(screens.meetingMounted).not.toHaveBeenCalled();
    await act(async () => button("会議").click());
    await vi.waitFor(() => expect(screens.meetingRequested).toHaveBeenCalledOnce());
    expect(host.querySelector('[aria-busy="true"]')?.textContent).toContain("画面を準備しています…");
    await act(async () => button("ホームへ戻る").click());
    expect(host.textContent).toContain("今日は、誰と話しますか？");

    await act(async () => { screens.finishMeetingLoad(); await vi.dynamicImportSettled(); });
    expect(screens.meetingMounted).not.toHaveBeenCalled();
    await act(async () => button("会議").click());
    await vi.waitFor(() => expect(host.textContent).toContain("会議画面"));
    expect(screens.meetingRequested).toHaveBeenCalledOnce();
    expect(screens.sessionRequested).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
