import { describe, expect, it, vi } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { neutralParams, type AvatarProvider, type CharacterDefinition } from "@rcai/avatar-core";
import { LocalAvatarFallback } from "./localAvatarFallback.js";

const character = {
  manifest: { id: "vrm-sample", name: "VRM Sample", renderer: "vrm", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "gentle", voiceProfiles: [] },
  baseUrl: "/characters/vrm-sample", model: "model/avatar.vrm", expressions: {}, motions: {}, voice: { characterId: "vrm-sample", voices: {} },
} satisfies CharacterDefinition;

function provider(id: string) {
  const state = { active: false };
  const avatar = {
    id, state,
    prepare: vi.fn(async (_character: CharacterDefinition) => {}),
    start: vi.fn(async () => { state.active = true; }),
    stop: vi.fn(async () => { state.active = false; }),
    pushAudio: vi.fn(), setState: vi.fn(), setEmotion: vi.fn(), performGesture: vi.fn(), setGaze: vi.fn(), interrupt: vi.fn(),
    blink: vi.fn(), setMicroMotion: vi.fn(), playMotion: vi.fn(), getParams: vi.fn(() => neutralParams()),
  } satisfies AvatarProvider & { state: { active: boolean } };
  return avatar;
}

function setup() {
  const primary = provider("vrm"), fallback = provider("canvas");
  const create = vi.fn(async () => fallback);
  const notice = vi.fn();
  return { primary, fallback, create, notice, avatar: new LocalAvatarFallback(primary, create, notice) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("local VRM fallback lifecycle", () => {
  it("keeps a healthy VRM and delegates only to it without creating fallback media", async () => {
    const { avatar, primary, create, notice } = setup();
    await avatar.prepare(character);
    await avatar.start();
    const frame = createFrame(new Float32Array([0.25]));
    avatar.pushAudio(frame);
    avatar.setState("SPEAKING");
    avatar.setEmotion("smile", 0.5);
    avatar.setGaze({ kind: "user" });
    avatar.interrupt();
    expect(avatar.id).toBe("vrm");
    expect(primary.prepare).toHaveBeenCalledWith(character);
    expect(primary.pushAudio).toHaveBeenCalledWith(frame);
    expect(primary.interrupt).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
    await avatar.stop();
    avatar.pushAudio(frame);
    expect(primary.pushAudio).toHaveBeenCalledOnce();
    expect(primary.state.active).toBe(false);
  });

  it("cleans the failed VRM and reports the actual canvas renderer while preserving the requested identity", async () => {
    const { avatar, primary, fallback, create, notice } = setup();
    primary.prepare.mockRejectedValue(new Error("invalid VRM"));
    await avatar.prepare(character);
    expect(primary.stop).toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    expect(fallback.prepare).toHaveBeenCalledWith(character);
    expect(avatar.id).toBe("canvas");
    expect(character.manifest.renderer).toBe("vrm");
    expect(notice).toHaveBeenCalledWith("vrm_model_unavailable");
    await avatar.start();
    expect(primary.start).not.toHaveBeenCalled();
    expect(fallback.state.active).toBe(true);
    await avatar.stop();
    expect(fallback.state.active).toBe(false);
  });

  it("does not create fallback after primary preparation resolves following stop", async () => {
    const { avatar, primary, create, notice } = setup();
    const pending = deferred();
    primary.prepare.mockImplementation(async () => { await pending.promise; primary.state.active = true; });
    const prepared = expect(avatar.prepare(character)).rejects.toThrow("AVATAR_PREPARE_CANCELLED");
    await avatar.stop();
    pending.resolve();
    await prepared;
    expect(primary.state.active).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("releases a fallback factory that resolves only after stop without preparing or starting it", async () => {
    const { avatar, primary, fallback, create, notice } = setup();
    primary.prepare.mockRejectedValue(new Error("invalid VRM"));
    const pending = deferred(), entered = deferred();
    create.mockImplementation(async () => { entered.resolve(); await pending.promise; fallback.state.active = true; return fallback; });
    const prepared = expect(avatar.prepare(character)).rejects.toThrow("AVATAR_PREPARE_CANCELLED");
    await entered.promise;
    await avatar.stop();
    pending.resolve();
    await prepared;
    expect(fallback.state.active).toBe(false);
    expect(fallback.prepare).not.toHaveBeenCalled();
    expect(fallback.start).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("releases fallback preparation that finishes after stop without reporting a successful switch", async () => {
    const { avatar, primary, fallback, notice } = setup();
    primary.prepare.mockRejectedValue(new Error("invalid VRM"));
    const pending = deferred(), entered = deferred();
    fallback.prepare.mockImplementation(async () => { entered.resolve(); await pending.promise; fallback.state.active = true; });
    const prepared = expect(avatar.prepare(character)).rejects.toThrow("AVATAR_PREPARE_CANCELLED");
    await entered.promise;
    await avatar.stop();
    pending.resolve();
    await prepared;
    expect(fallback.state.active).toBe(false);
    expect(fallback.start).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it("cleans a fallback that also fails preparation and preserves its failure", async () => {
    const { avatar, primary, fallback, notice } = setup();
    primary.prepare.mockRejectedValue(new Error("invalid VRM"));
    const failure = new Error("canvas unavailable");
    fallback.prepare.mockImplementation(async () => { fallback.state.active = true; throw failure; });
    await expect(avatar.prepare(character)).rejects.toBe(failure);
    expect(primary.stop).toHaveBeenCalled();
    expect(fallback.stop).toHaveBeenCalled();
    expect(fallback.state.active).toBe(false);
    expect(notice).not.toHaveBeenCalled();
    await avatar.stop();
  });

  it("never opens model resources when prepare is called after stop", async () => {
    const { avatar, primary, create } = setup();
    await avatar.stop();
    await expect(avatar.prepare(character)).rejects.toThrow("AVATAR_PREPARE_CANCELLED");
    expect(primary.prepare).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("stops media allocated by a start that resolves after the owner stopped", async () => {
    const { avatar, primary, create } = setup();
    const pending = deferred();
    await avatar.prepare(character);
    primary.start.mockImplementation(async () => { await pending.promise; primary.state.active = true; });
    const started = avatar.start();
    await avatar.stop();
    pending.resolve();
    await started.catch(() => {});
    expect(primary.state.active).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
