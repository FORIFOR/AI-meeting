// @vitest-environment jsdom
import { act, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CharacterSelect } from "./CharacterSelect.js";
import { DEFAULT_SETTINGS, settingsReducer, type Settings, type SettingsAction } from "../state/settings.js";
import type { BrokerHealth } from "../api/health.js";
import { createAvatarProvider, type CharacterEntry } from "../integrations/registry.js";

const preview = vi.hoisted(() => ({ prepare: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}) }));
vi.mock("@rcai/avatar-core", () => ({ loadCharacter: vi.fn(async () => ({ model: "model/model3.json" })) }));
vi.mock("../integrations/registry.js", () => ({ createAvatarProvider: vi.fn(async () => preview) }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const characters: CharacterEntry[] = [
  { id: "yui", name: "Yui", renderer: "live2d", baseUrl: "/characters/yui" },
  { id: "haru", name: "Haru", renderer: "live2d", baseUrl: "/characters/haru" },
];
const readyBroker: BrokerHealth = {
  ok: true,
  providers: { openai: true, google: true, livekit: false, heygen: false, tavus: false },
  avatars: { anam: { configured: true, characterIds: ["yui"] } },
};

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

it("keeps a way back while character data is still unavailable", () => {
  const html = renderToStaticMarkup(<CharacterSelect characters={[]} settings={DEFAULT_SETTINGS} dispatch={() => {}} broker={null} onDone={() => {}} />);
  expect(html).toContain("キャラクターがありません。");
  expect(html).toContain(">戻る</button>");
});

it.each([
  { name: "unknown broker", broker: null },
  { name: "unconfigured service", broker: { ...readyBroker, avatars: { anam: { configured: false, characterIds: ["yui"] } } } },
  { name: "another character only", broker: { ...readyBroker, avatars: { anam: { configured: true, characterIds: ["haru"] } } } },
])("keeps lightweight available while natural display is unavailable: $name", ({ broker }) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CharacterSelect characters={characters} settings={{ ...DEFAULT_SETTINGS, characterId: "yui" }} dispatch={() => {}} broker={broker} onDone={() => {}} />);
  expect(host.querySelector<HTMLInputElement>('input[value="lightweight"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[value="lightweight"]')?.disabled).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.disabled).toBe(true);
  expect(host.textContent).toContain("この相手の自然な表示は準備中です");
  expect(host.textContent).not.toMatch(/Cara|APIキー|SDK/);
});

it("shows lightweight under strict local even with a saved natural preference and configured broker", () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, characterId: "yui", privacyMode: "strict_local", avatarQuality: { yui: "natural" } };
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<CharacterSelect characters={characters} settings={settings} dispatch={() => {}} broker={readyBroker} onDone={() => {}} />);
  expect(host.querySelector<HTMLInputElement>('input[value="lightweight"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.checked).toBe(false);
  expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.disabled).toBe(true);
  expect(host.textContent).toContain("完全ローカルでは軽量表示を使います");
});

it("keeps external rendering disabled in the OSS build even with a configured service and saved choice", () => {
  vi.stubEnv("VITE_RCAI_OSS", "true");
  const host = document.createElement("div");
  const settings: Settings = { ...DEFAULT_SETTINGS, characterId: "yui", privacyMode: "default", avatarQuality: { yui: "natural" } };
  host.innerHTML = renderToStaticMarkup(<CharacterSelect characters={characters} settings={settings} dispatch={() => {}} broker={readyBroker} onDone={() => {}} />);
  expect(host.querySelector<HTMLInputElement>('input[value="lightweight"]')?.checked).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.checked).toBe(false);
  expect(host.textContent).toContain("この配布版では軽量表示を使います");
});

it("does not opt into external sending when the broker becomes configured", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const dispatch = vi.fn();
  const settings = { ...DEFAULT_SETTINGS, characterId: "yui" };
  const render = (broker: BrokerHealth | null) => root.render(<CharacterSelect characters={characters} settings={settings} dispatch={dispatch} broker={broker} onDone={() => {}} />);
  try {
    await act(async () => render(null));
    await act(async () => render(readyBroker));
    expect(host.querySelector<HTMLInputElement>('input[value="lightweight"]')?.checked).toBe(true);
    expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.checked).toBe(false);
    expect(host.querySelector<HTMLInputElement>('input[value="natural"]')?.disabled).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(createAvatarProvider).toHaveBeenCalledOnce();
    expect(createAvatarProvider).toHaveBeenCalledWith("live2d", expect.objectContaining({ framing: "preview" }));
    expect(preview.start).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
});

it("changes only the current character's display preference and keeps the existing preview", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dispatched = vi.fn();
  const onDone = vi.fn();
  function Harness() {
    const [settings, dispatch] = useReducer(settingsReducer, { ...DEFAULT_SETTINGS, characterId: "yui" });
    const onAction = (action: SettingsAction) => { dispatched(action); dispatch(action); };
    return <CharacterSelect characters={characters} settings={settings} dispatch={onAction} broker={readyBroker} onDone={onDone} />;
  }
  const radio = (value: string) => host.querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  const button = (label: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(<Harness />));
    expect(createAvatarProvider).toHaveBeenCalledOnce();
    expect(createAvatarProvider).toHaveBeenCalledWith("live2d", expect.objectContaining({ framing: "preview" }));
    expect(radio("natural").disabled).toBe(false);
    expect(radio("lightweight").checked).toBe(true);
    expect(dispatched).not.toHaveBeenCalled();
    const disclosure = host.querySelector("#avatar-quality-transmission")!;
    expect(radio("natural").getAttribute("aria-describedby")).toContain(disclosure.id);
    expect(disclosure.textContent).toContain("AIの返答音声を外部サービスのAnamへ送信");
    expect(disclosure.textContent).toContain("会議内容が含まれる");
    expect(disclosure.textContent).toContain("次回の会話にも使います");
    expect(radio("natural").closest("label")?.textContent).toContain("外部送信を許可");
    await act(async () => radio("natural").click());
    expect(radio("natural").checked).toBe(true);
    expect(dispatched.mock.calls).toEqual([[{ type: "avatarQuality", characterId: "yui", quality: "natural" }]]);
    expect(createAvatarProvider).toHaveBeenCalledOnce();
    expect(preview.stop).not.toHaveBeenCalled();
    expect(host.textContent).toContain("準備や応答に時間が加わり");
    expect(host.textContent).toContain("発話の切り替わりで軽量表示に戻ります");

    // Radio keyboard navigation must not invoke the global character switch shortcut.
    await act(async () => radio("natural").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(host.querySelector("h1")?.textContent).toContain("Yui");
    await act(async () => button("Haru").click());
    expect(radio("lightweight").checked).toBe(true);
    expect(radio("natural").disabled).toBe(true);
    await act(async () => button("Yui").click());
    expect(radio("natural").checked).toBe(true);
    await act(async () => radio("lightweight").click());
    expect(radio("lightweight").checked).toBe(true);
    expect(dispatched).toHaveBeenLastCalledWith({ type: "avatarQuality", characterId: "yui", quality: "lightweight" });
    expect(onDone).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
