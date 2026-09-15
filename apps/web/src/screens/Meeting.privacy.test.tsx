// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Meeting, type MeetingProps } from "./Meeting.js";
import { DEFAULT_SETTINGS, type Settings } from "../state/settings.js";

const capture = vi.hoisted(() => ({
  construct: vi.fn(), start: vi.fn(async () => {}), leave: vi.fn(async () => {}),
  activateBotPage: vi.fn(),
}));
vi.mock("../session/MeetingSessionController.js", () => ({
  MeetingSessionController: class {
    constructor(init: unknown) { capture.construct(init); }
    start = capture.start;
    leave = capture.leave;
    stop() {}
    dispose() {}
  },
  validatedAvatarQuality: () => undefined,
}));
vi.mock("@rcai/connector-recall", () => ({ activateBotPage: capture.activateBotPage }));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const brokerUrl = "https://broker.example.test";
const meetingUrl = "https://meet.google.com/abc-defg-hij";
const settings: Settings = { ...DEFAULT_SETTINGS, brokerUrl, privacyMode: "default", engine: "google", characterId: "yui" };
const strictSettings: Settings = { ...settings, privacyMode: "strict_local", engine: "local" };
const notice = "設定でクラウドの利用を有効にしてください";
const props: Omit<MeetingProps, "settings"> = {
  initialUrl: meetingUrl,
  availability: { google: true, openai: false, local: true },
  characters: [{ id: "yui", name: "Yui", renderer: "canvas", baseUrl: "/characters/yui", license: "test" }],
  personas: [{ id: "friend", name: "雑談", mode: "free_talk", language: "ja-JP" }] as MeetingProps["personas"],
  brokerMeeting: { attendee: true, recall: false, recallPublicUrl: true, recallBotPageUrl: true },
  onBack: () => {},
};

describe("Meeting privacy boundary", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    sessionStorage.setItem(`rcai.zoom.session:${brokerUrl}`, "existing-zoom-session");
    fetchMock = vi.fn<typeof fetch>(async input => {
      const path = new URL(String(input), location.origin).pathname;
      const body = path === "/api/zoom/config" ? { available: true }
        : path === "/api/zoom/status" ? { connected: true }
          : path === "/meeting-credit-usage.json" ? {} : null;
      if (body === null) throw new Error(`Unexpected request: ${input}`);
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal("fetch", fetchMock);
    capture.activateBotPage.mockResolvedValue({
      sessionId: "session-1", botId: "bot-1", clientToken: "client-token", activations: 1,
      clientWsUrl: "wss://broker.example.test/relay",
      botPageQuery: { character: "yui", persona: "friend", engine: "google", provider: "attendee" },
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  const render = async (next: Settings, botParams?: MeetingProps["botParams"]) => {
    await act(async () => root.render(<Meeting {...props} settings={next} botParams={botParams} />));
    await act(async () => vi.dynamicImportSettled());
  };
  const joinButton = () => [...host.querySelectorAll("button")].find(button => button.textContent === "参加する");

  it("shows the public demo notice without billing or Zoom requests", async () => {
    await act(async () => root.render(<Meeting {...props} settings={settings} broker={{
      ok: true, providers: { openai: false, google: false, livekit: false, heygen: false, tavus: false },
      publicAccess: { mode: "demo_only", reason: "PUBLIC_DEMO_ONLY" },
    }} />));
    expect(host.querySelector('a[href="/vrm-demo.html"]')).not.toBeNull();
    expect(host.textContent).not.toContain("初期付与");
    expect(host.textContent).not.toContain("残りのクレジット");
    expect(joinButton()?.disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("blocks operator joining and even Zoom discovery with a saved session in strict_local", async () => {
    await render(strictSettings);

    expect(host.textContent).toContain(notice);
    expect(fetchMock).not.toHaveBeenCalled();
    const join = joinButton();
    expect(join === undefined || join.disabled).toBe(true);
    if (join) await act(async () => join.click());
    expect(capture.construct).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(capture.activateBotPage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restores Zoom checks and operator joining after cloud is enabled", async () => {
    await render(strictSettings);
    expect(fetchMock).not.toHaveBeenCalled();
    await render(settings);

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls).toContain(`${brokerUrl}/api/zoom/config`);
    expect(urls).toContain(`${brokerUrl}/api/zoom/status`);
    expect(host.textContent).toContain("Zoom 連携済み");
    expect(host.textContent).not.toContain(notice);
    expect(joinButton()?.disabled).toBe(false);
    await act(async () => joinButton()!.click());
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.construct).toHaveBeenCalledWith(expect.objectContaining({ role: "operator", meetingUrl }));
  });

  it("keeps a signed bot page inactive in strict_local and activates only after cloud is enabled", async () => {
    const botParams = { token: "signed-single-use-token", brokerUrl };
    await render(strictSettings, botParams);

    expect(host.textContent).toContain(notice);
    expect(capture.activateBotPage).not.toHaveBeenCalled();
    expect(capture.construct).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    await render(settings, botParams);
    expect(capture.activateBotPage).toHaveBeenCalledExactlyOnceWith(brokerUrl, botParams.token);
    expect(capture.start).toHaveBeenCalledTimes(1);
    expect(capture.construct).toHaveBeenCalledWith(expect.objectContaining({
      role: "bot", botToken: botParams.token,
      botActivation: { sessionId: "session-1", botId: "bot-1", clientToken: "client-token" },
    }));
  });

  it("does not probe or start when a pending bot activation resolves after switching to strict_local", async () => {
    const botParams = { token: "pending-single-use-token", brokerUrl };
    const activation = {
      sessionId: "late-session", botId: "late-bot", clientToken: "late-client-token", activations: 1,
      brokerUrl: "https://activated-broker.example.test", agentUrl: "wss://activated-agent.example.test",
      clientWsUrl: "wss://activated-broker.example.test/relay",
      botPageQuery: {
        character: "yui", persona: "friend", name: "Stale bot display name", engine: "local", provider: "attendee",
      },
    };
    let resolveActivation!: (value: typeof activation) => void;
    capture.activateBotPage.mockImplementationOnce(() => new Promise(resolve => { resolveActivation = resolve; }));

    await render(settings, botParams);
    expect(capture.activateBotPage).toHaveBeenCalledExactlyOnceWith(brokerUrl, botParams.token);
    expect(capture.start).not.toHaveBeenCalled();

    await render(strictSettings, botParams);
    expect(host.textContent).toContain(notice);
    const localContent = host.textContent;
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => resolveActivation(activation));
    await act(async () => vi.dynamicImportSettled());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(capture.construct).not.toHaveBeenCalled();
    expect(capture.start).not.toHaveBeenCalled();
    expect(host.textContent).toBe(localContent);
    expect(host.textContent).not.toContain(activation.botPageQuery.name);
  });
});
