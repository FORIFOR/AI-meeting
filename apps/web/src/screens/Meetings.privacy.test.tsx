// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Meetings } from "./Meetings.js";
import { DEFAULT_SETTINGS, type Settings } from "../state/settings.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const brokerUrl = "https://broker.example.test";
const settings: Settings = { ...DEFAULT_SETTINGS, brokerUrl, privacyMode: "default" };
const strictSettings: Settings = { ...settings, privacyMode: "strict_local", engine: "local" };
const notice = "設定でクラウドの利用を有効にしてください";
const meeting = {
  id: "record-1", title: "Remote meeting record", meetingUrl: "https://meet.google.com/abc-defg-hij",
  source: "url", status: "ended", hasTranscript: true,
  createdAt: "2026-09-01T01:00:00Z", updatedAt: "2026-09-01T02:00:00Z",
};

function responseFor(input: RequestInfo | URL): Response {
  const path = new URL(String(input)).pathname;
  const body = path === "/api/calendar/status" ? { connected: true }
    : path === "/api/calendar/events" ? []
      : path === "/api/meetings" ? [meeting]
        : path === "/api/calendar/rule" ? { markers: ["#yui"], leadMinutes: 2 }
          : null;
  if (body === null) throw new Error(`Unexpected request: ${input}`);
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

describe("Meetings privacy boundary", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn<typeof fetch>(async input => responseFor(input));
    vi.stubGlobal("fetch", fetchMock);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async (next: Settings) => {
    await act(async () => root.render(<Meetings settings={next}
      brokerMeeting={{ attendee: true, recall: false, recallPublicUrl: true, recallBotPageUrl: true }}
      onOpenMeeting={() => {}} onUrlFlow={() => {}} onBack={() => {}} />));
  };

  it("does not load or poll a remote broker while strict_local is selected", async () => {
    await render(strictSettings);
    expect(host.textContent).toContain(notice);
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("読み込んでいます");
  });

  it("resumes loading when cloud is enabled and stops an existing poll when strict_local returns", async () => {
    await render(strictSettings);
    await render(settings);

    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort()).toEqual([
      `${brokerUrl}/api/calendar/events`, `${brokerUrl}/api/calendar/rule`,
      `${brokerUrl}/api/calendar/status`, `${brokerUrl}/api/meetings`,
    ].sort());
    expect(host.textContent).toContain(meeting.title);
    expect(host.textContent).not.toContain(notice);

    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(fetchMock).toHaveBeenCalledTimes(8);

    await render(strictSettings);
    fetchMock.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain(notice);
    expect(host.textContent).not.toContain(meeting.title);
  });

  it("ignores cloud responses that arrive after switching to strict_local", async () => {
    const pending: Array<() => void> = [];
    fetchMock.mockImplementation(input => new Promise(resolve => {
      pending.push(() => resolve(responseFor(input)));
    }));
    await render(settings);
    expect(pending).toHaveLength(4);

    await render(strictSettings);
    fetchMock.mockClear();
    await act(async () => { for (const resolve of pending) resolve(); });
    await act(async () => vi.advanceTimersByTimeAsync(40_000));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain(notice);
    expect(host.textContent).not.toContain(meeting.title);
  });
});
