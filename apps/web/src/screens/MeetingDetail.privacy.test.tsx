// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MeetingDetail } from "./MeetingDetail.js";
import { DEFAULT_SETTINGS, type Settings } from "../state/settings.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const settings = (privacyMode: Settings["privacyMode"]): Settings => ({ ...DEFAULT_SETTINGS, brokerUrl: "https://broker.test", privacyMode });
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps meeting details local until cloud use is enabled", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/transcript") ? { utterances: [{ speaker: "Speaker", text: "Cloud transcript" }] } : { id: "one", status: "ended", hasTranscript: true, title: "Cloud meeting" }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<MeetingDetail settings={settings("strict_local")} meetingId="one" onBack={vi.fn()} />));
  expect(fetcher).not.toHaveBeenCalled(); expect(host.textContent).toContain("設定でクラウドの利用を有効にしてください");
  await act(async () => root.render(<MeetingDetail settings={settings("default")} meetingId="one" onBack={vi.fn()} />));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://broker.test/api/meetings/one", "https://broker.test/api/meetings/one/transcript"]);
  expect(host.textContent).toContain("Cloud transcript");
});

it("does not fetch a transcript from a late detail response after strict_local", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<MeetingDetail settings={settings("default")} meetingId="one" onBack={vi.fn()} />));
  await act(async () => root.render(<MeetingDetail settings={settings("strict_local")} meetingId="one" onBack={vi.fn()} />));
  await act(async () => finish(Response.json({ id: "one", status: "ended", hasTranscript: true, title: "Old cloud meeting" })));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(host.textContent).not.toContain("Old cloud meeting");
});
