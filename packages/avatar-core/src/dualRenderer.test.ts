import { describe, expect, it, vi } from "vitest";
import { DualRenderer } from "./dualRenderer.js";
import { AvatarRuntime } from "./avatarRuntime.js";
import type { AvatarProvider, CharacterDefinition, SynchronizedAvatarAudio } from "./types.js";

function provider(id: string): AvatarProvider {
  return { id, prepare: vi.fn(async () => {}), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    pushAudio: vi.fn(), setState: vi.fn(), setEmotion: vi.fn(), performGesture: vi.fn(), setGaze: vi.fn(), interrupt: vi.fn() };
}
function setup() {
  const local = provider("live2d");
  const listeners = new Set<(e: Error) => void>();
  const audio: SynchronizedAvatarAudio = {
    pushSourceAudio: vi.fn(), endSourceTurn: vi.fn(), getOutputStream: () => ({} as MediaStream),
    onFailure: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  const natural = { ...provider("anam"), synchronizedAudio: audio };
  const layer = () => ({ style: { visibility: "" }, remove: vi.fn() }) as unknown as HTMLElement;
  const localContainer = layer(), naturalContainer = layer(), onFallback = vi.fn();
  const dual = new DualRenderer({ local, natural, localContainer, naturalContainer, onFallback });
  return { dual, local, natural, localContainer, naturalContainer, listeners, onFallback };
}
const identity = { manifest: { id: "yui", renderer: "live2d" }, voice: { characterId: "yui" } } as CharacterDefinition;

describe("same-character renderer selection", () => {
  it("retains the exact character and switches only after synchronized output is ready", async () => {
    const s = setup();
    let ready!: () => void;
    s.natural.start = vi.fn(() => new Promise<void>((resolve) => { ready = resolve; }));
    await s.dual.prepare(identity);
    expect(s.local.prepare).toHaveBeenCalledWith(identity);
    expect(s.natural.prepare).toHaveBeenCalledWith(identity);
    const start = s.dual.start();
    await Promise.resolve();
    expect(s.dual.synchronizedAudio).toBeUndefined();
    expect(s.localContainer.style.visibility).toBe("visible");
    ready(); await start;
    expect(s.dual.id).toBe("anam");
    expect(s.dual.synchronizedAudio).toBe(s.natural.synchronizedAudio);
    expect(s.naturalContainer.style.visibility).toBe("visible");
  });
  it("failed credentials preserve the same prepared local view without starting a cloud stream", async () => {
    const s = setup();
    s.natural.prepare = vi.fn(async () => { throw new Error("BLOCKED_BY_ANAM_KEY"); });
    await s.dual.prepare(identity); await s.dual.start();
    expect(s.local.start).toHaveBeenCalledOnce();
    expect(s.natural.start).not.toHaveBeenCalled();
    expect(s.dual.id).toBe("live2d");
    expect(s.onFallback).toHaveBeenCalledOnce();
  });
  it("a failed media connection releases external resources and forwards future played PCM locally", async () => {
    const s = setup(); await s.dual.prepare(identity); await s.dual.start();
    for (const l of s.listeners) l(new Error("lost"));
    expect(s.natural.stop).toHaveBeenCalledOnce();
    expect(s.dual.synchronizedAudio).toBeUndefined();
    expect(s.localContainer.style.visibility).toBe("visible");
    const frame = { data: new Float32Array([0.2]), sampleRate: 48000, timestamp: 0, channels: 1 as const };
    s.dual.pushAudio(frame);
    expect(s.local.pushAudio).toHaveBeenCalledWith(frame);
    expect(s.natural.pushAudio).not.toHaveBeenCalled();
  });
  it("leaving during external start never selects late media", async () => {
    const s = setup(); let ready!: () => void;
    s.natural.start = vi.fn(() => new Promise<void>((resolve) => { ready = resolve; }));
    await s.dual.prepare(identity); const start = s.dual.start(); await Promise.resolve();
    await s.dual.stop(); ready(); await start;
    expect(s.dual.synchronizedAudio).toBeUndefined();
    expect(s.localContainer.remove).toHaveBeenCalled();
    expect(s.naturalContainer.remove).toHaveBeenCalled();
    expect(s.natural.stop).toHaveBeenCalledTimes(2);
  });
  it("source completion and full-duplex acknowledgement do not cancel returned media; confirmed interruption does", async () => {
    const s = setup(); await s.dual.prepare(identity); await s.dual.start();
    const runtime = new AvatarRuntime(s.dual);
    runtime.handleEvent({ type: "assistant_speech_started", at: 0 });
    runtime.handleEvent({ type: "user_speech_started", at: 1 });
    expect(s.natural.interrupt).not.toHaveBeenCalled();
    runtime.handleEvent({ type: "assistant_speech_ended", at: 2 });
    expect(s.natural.interrupt).not.toHaveBeenCalled();
    runtime.handleEvent({ type: "interrupted", at: 3 });
    expect(s.natural.interrupt).toHaveBeenCalledOnce();
    expect(s.dual.synchronizedAudio).toBeUndefined();
  });
});
