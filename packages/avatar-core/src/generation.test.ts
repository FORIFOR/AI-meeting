import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { AvatarRuntime } from "./avatarRuntime.js";
import { MotionStackAvatarBase } from "./motionStackAvatar.js";
import type { AvatarParams } from "./types.js";

class TestAvatar extends MotionStackAvatarBase {
  id = "test";
  protected async loadModel() {}
  protected applyParams(_p: AvatarParams) {}
  protected async disposeModel() {}
}

function loud(ms = 10): Float32Array {
  const n = Math.round((48000 * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.4 * Math.sin(i / 9) + 0.25 * Math.sin(i / 3);
  return out;
}

describe("avatar generation epoch", () => {
  it("late events of an interrupted generation never flip the state or the mouth", async () => {
    let t = 0;
    const avatar = new TestAvatar({ clock: () => t, scheduler: "manual" });
    await avatar.start();
    const rt = new AvatarRuntime(avatar, { clock: () => t });
    const gen = (generationId: number, sequence = 0) => ({ sessionId: "s", turnId: 1, generationId, sequence });
    rt.handleEvent({ type: "assistant_speech_started", gen: gen(1) });
    for (let i = 0; i < 20; i++) { avatar.pushAudio(createFrame(loud(), 48000, t)); t += 10; avatar.tick(t); }
    expect(rt.state).toBe("SPEAKING");
    expect(avatar.getParams().mouthOpenY).toBeGreaterThan(0.2);
    // Barge-in.
    rt.handleEvent({ type: "user_speech_started", at: t });
    expect(rt.state).toBe("LISTENING");
    expect(avatar.getParams().mouthOpenY).toBe(0);
    // Late chunks of generation 1: state events are ignored, audio pushed while not speaking is ignored.
    rt.handleEvent({ type: "assistant_speech_started", gen: gen(1, 50) });
    rt.handleEvent({ type: "assistant_audio", frame: createFrame(loud(), 48000, t), gen: gen(1, 51) });
    for (let i = 0; i < 10; i++) { avatar.pushAudio(createFrame(loud(), 48000, t)); t += 10; avatar.tick(t); }
    expect(rt.state).toBe("LISTENING");
    expect(avatar.getParams().mouthOpenY).toBe(0);
    expect(rt.stats.staleDrops).toBe(2);
    rt.handleEvent({ type: "assistant_speech_ended", gen: gen(1, 60) });
    expect(rt.state).toBe("LISTENING");
    // New generation opens the mouth again — and starts from a clean analyser (no stale energy).
    rt.handleEvent({ type: "user_speech_ended", at: t });
    rt.handleEvent({ type: "assistant_speech_started", gen: gen(2) });
    expect(rt.state).toBe("SPEAKING");
    avatar.tick(t + 1);
    expect(avatar.getParams().mouthOpenY).toBe(0); // nothing played yet for gen 2
    for (let i = 0; i < 20; i++) { avatar.pushAudio(createFrame(loud(), 48000, t)); t += 10; avatar.tick(t); }
    expect(avatar.getParams().mouthOpenY).toBeGreaterThan(0.2);
    await avatar.stop();
  });
});
