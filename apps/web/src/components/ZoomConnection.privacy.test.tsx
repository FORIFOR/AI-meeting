// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ZoomConnection, ZoomReturn } from "./ZoomConnection.js";

const calls = vi.hoisted(() => ({ complete: vi.fn(), connect: vi.fn(), disconnect: vi.fn() }));
vi.mock("../api/zoom.js", () => ({ completeZoom: calls.complete, connectZoom: calls.connect, disconnectZoom: calls.disconnect, zoomToken: () => "saved-session" }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  history.replaceState(null, "", "/"); vi.clearAllMocks();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });

it("does not discover Zoom or redeem an OAuth callback under strict_local", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  history.replaceState(null, "", "/#zoom_oauth=pending");
  await act(async () => root.render(<><ZoomConnection base="https://broker.test" meetingUrl="" disabled={false} privacyMode="strict_local" /><ZoomReturn privacyMode="strict_local" onDone={vi.fn()} /></>));
  expect(fetcher).not.toHaveBeenCalled(); expect(calls.complete).not.toHaveBeenCalled();
  expect(host.textContent).toContain("設定でクラウドの利用を有効にしてください");
});

it("aborts discovery and ignores a late config result after switching to strict_local", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<ZoomConnection base="https://broker.test" meetingUrl="" disabled={false} privacyMode="default" />));
  const signal = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
  await act(async () => root.render(<ZoomConnection base="https://broker.test" meetingUrl="" disabled={false} privacyMode="strict_local" />));
  expect(signal.aborted).toBe(true);
  await act(async () => finish(Response.json({ available: true })));
  expect(fetcher).toHaveBeenCalledTimes(1); // No status fetch using the stored session.
  expect(host.textContent).toBe("");
});

it("discovers the saved Zoom connection when cloud use is enabled", async () => {
  const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/config") ? { available: true } : { connected: true })); vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(<ZoomConnection base="https://broker.test" meetingUrl="" disabled={false} privacyMode="default" />));
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(["https://broker.test/api/zoom/config", "https://broker.test/api/zoom/status"]);
  expect(host.textContent).toContain("Zoom 連携済み");
});

it("does not navigate into a meeting when an old OAuth completion resolves after strict_local", async () => {
  let finish!: () => void;
  calls.complete.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  history.replaceState(null, "", "/#zoom_oauth=pending"); const done = vi.fn();
  await act(async () => root.render(<ZoomReturn privacyMode="default" onDone={done} />));
  await act(async () => root.render(<ZoomReturn privacyMode="strict_local" onDone={done} />));
  await act(async () => finish());
  expect(calls.complete).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
});

it("redeems an existing callback after the user enables cloud use", async () => {
  calls.complete.mockResolvedValue(undefined); history.replaceState(null, "", "/#zoom_oauth=pending"); const done = vi.fn();
  await act(async () => root.render(<ZoomReturn privacyMode="strict_local" onDone={done} />));
  await act(async () => root.render(<ZoomReturn privacyMode="default" onDone={done} />));
  expect(calls.complete).toHaveBeenCalledOnce(); expect(done).toHaveBeenCalledOnce();
});
