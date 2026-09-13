// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceOrb, type VoiceOrbProps } from "./VoiceOrb.js";
import { SILENT_VOICE } from "../session/voiceActivity.js";

const gpu = vi.hoisted(() => ({ create: vi.fn(), draw: vi.fn(), dispose: vi.fn() }));
vi.mock("./voice-orb/renderer.js", () => ({ createVoiceOrbRenderer: gpu.create }));
let host: HTMLDivElement;
let root: Root;
let frames: Map<number, FrameRequestCallback>;
let seq = 0;
let time = 100;
let reduced = false;
let props: VoiceOrbProps;
const step = async () => { await act(async () => { const pending = [...frames.values()]; frames.clear(); time += 40; pending.forEach(cb => cb(time)); }); };
const render = async () => { await act(async () => root.render(<VoiceOrb {...props} />)); await step(); };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map(); reduced = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { frames.set(++seq, cb); return seq; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("matchMedia", () => ({ get matches() { return reduced; }, addEventListener() {}, removeEventListener() {} }));
  gpu.create.mockResolvedValue({ draw: gpu.draw, dispose: gpu.dispose });
  gpu.draw.mockClear(); gpu.dispose.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = { avatarState: "THINKING", phase: "live" };
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("updates accessible labels for input, inference, playback and mute without recreating the canvas", async () => {
  await render(); const canvas = host.querySelector("canvas");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("考えています");
  props = { ...props, avatarState: "LISTENING" }; await render(); expect(host.textContent).toBe("聞いています");
  props = { ...props, readLevels: () => ({ input: 0, output: .6, playing: true }) }; await render(); expect(host.textContent).toBe("話しています");
  props = { ...props, readLevels: () => SILENT_VOICE, muted: true }; await render(); expect(host.textContent).toBe("マイクはミュート中");
  expect(host.querySelector("canvas")).toBe(canvas);
});
it("keeps the fallback and live state labels when the GPU is unavailable", async () => {
  gpu.create.mockResolvedValue(null); await render();
  expect(host.querySelector(".voice-orb")?.getAttribute("data-renderer")).toBe("fallback");
  props = { ...props, phase: "error" }; await render(); expect(host.textContent).toBe("会話が停止しました");
});
it("draws a static pose for reduced motion, suspends hidden tabs and releases resources", async () => {
  reduced = true; await render(); gpu.draw.mockClear(); await step(); await step(); expect(gpu.draw).not.toHaveBeenCalled();
  props = { ...props, avatarState: "LISTENING" }; await render(); expect(gpu.draw).toHaveBeenCalledTimes(1);
  expect(gpu.draw.mock.calls[0]?.[2]).toBe(true);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  await step(); expect(frames.size).toBe(0);
  hidden.mockReturnValue(false); document.dispatchEvent(new Event("visibilitychange")); await step(); expect(frames.size).toBe(1);
  hidden.mockRestore(); await act(async () => root.unmount());
  expect(gpu.dispose).toHaveBeenCalled(); expect(frames.size).toBe(0);
});
it("disposes a GPU that resolves after the component has left", async () => {
  let resolve!: (value: unknown) => void;
  gpu.create.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await render(); await act(async () => root.unmount());
  await act(async () => { resolve({ draw: gpu.draw, dispose: gpu.dispose }); });
  expect(gpu.dispose).toHaveBeenCalled(); expect(frames.size).toBe(0);
});
