// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";

beforeEach(() => { vi.resetModules(); sessionStorage.clear(); history.replaceState(null, "", "/"); vi.unstubAllGlobals(); });
it("redeems a callback only once and scopes the resulting session to its broker", async () => {
  history.replaceState(null, "", "/#zoom_oauth=state");
  sessionStorage.setItem("rcai.zoom.pending", JSON.stringify({ base: "https://broker.test", verifier: "private-verifier", meetingUrl: "https://zoom.us/j/123" }));
  const request = vi.fn(async () => Response.json({ token: "private-session" })); vi.stubGlobal("fetch", request);
  const { completeZoom, zoomToken } = await import("./zoom.js");
  await Promise.all([completeZoom(), completeZoom()]);
  expect(request).toHaveBeenCalledTimes(1);
  expect(zoomToken("https://broker.test")).toBe("private-session");
  expect(zoomToken("https://other.test")).toBeNull();
  expect(sessionStorage.getItem("rcai.zoom.pending")).toBeNull();
  expect(location.hash).toBe("");
});
it("never exchanges an unsolicited callback lacking the initiating browser verifier", async () => {
  history.replaceState(null, "", "/#zoom_oauth=attacker-state");
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const { completeZoom } = await import("./zoom.js");
  await expect(completeZoom()).rejects.toThrow("連携を開始したタブ"); expect(request).not.toHaveBeenCalled();
});
it("retains the session to retry a failed revocation and removes it only after successful disconnect", async () => {
  sessionStorage.setItem("rcai.zoom.session:https://broker.test", "private-session");
  const request = vi.fn().mockResolvedValueOnce(new Response("failed", { status: 503 })).mockResolvedValueOnce(Response.json({ connected: false })); vi.stubGlobal("fetch", request);
  const { disconnectZoom, zoomToken } = await import("./zoom.js");
  await expect(disconnectZoom("https://broker.test")).rejects.toThrow("接続解除"); expect(zoomToken("https://broker.test")).toBe("private-session");
  await disconnectZoom("https://broker.test"); expect(zoomToken("https://broker.test")).toBeNull();
});
