import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { SILENT_VOICE, VoiceActivity, voiceOrbState } from "./voiceActivity.js";

const frame = (amplitude: number) => createFrame(new Float32Array(480).fill(amplitude));
describe("voice status reflects capture and playback", () => {
  it("distinguishes live input, inference and actual output (not merely generated chunks)", () => {
    const activity = new VoiceActivity();
    activity.capture(frame(.1));
    expect(activity.read().input).toBeGreaterThan(0);
    expect(voiceOrbState("LISTENING", "live", false, activity.read())).toBe("listening");
    expect(voiceOrbState("THINKING", "live", false, activity.read())).toBe("thinking");
    expect(voiceOrbState("SPEAKING", "live", false, activity.read())).toBe("thinking");
    activity.playback(frame(.1));
    expect(voiceOrbState("SPEAKING", "live", false, activity.read())).toBe("speaking");
    expect(voiceOrbState("IDLE", "live", false, activity.read())).toBe("speaking");
  });
  it("decays stale levels and holds the output label over real playback pauses", () => {
    let now = 0;
    const activity = new VoiceActivity(() => now);
    activity.capture(frame(.2)); activity.playback(frame(.2));
    now = 300;
    expect(activity.read()).toEqual(SILENT_VOICE);
    expect(activity.read(true)).toEqual({ ...SILENT_VOICE, playing: true });
    activity.resetOutput();
    expect(activity.read(true)).toEqual(SILENT_VOICE);
  });
  it("ignores silence and non-finite PCM and retains no source frame", () => {
    const activity = new VoiceActivity();
    activity.playback(frame(0)); expect(activity.read()).toEqual(SILENT_VOICE);
    activity.playback(frame(NaN)); expect(activity.read()).toEqual(SILENT_VOICE);
    const input = frame(.1); activity.capture(input); input.data.fill(0);
    expect(activity.read().input).toBeGreaterThan(0);
  });
  it("mute clears input without hiding audible AI output; interruption and exit clear output", () => {
    const activity = new VoiceActivity();
    activity.capture(frame(.1)); activity.playback(frame(.1)); activity.resetInput();
    expect(activity.read().input).toBe(0);
    expect(voiceOrbState("LISTENING", "live", true, activity.read())).toBe("speaking");
    activity.resetOutput();
    expect(voiceOrbState("LISTENING", "live", true, activity.read())).toBe("muted");
    activity.capture(frame(.1)); activity.reset(); expect(activity.read()).toEqual(SILENT_VOICE);
  });
  it.each(["starting", "ending", "ended", "error"] as const)("%s overrides late audio", phase => {
    const levels = { input: 1, output: 1, playing: true };
    expect(voiceOrbState("SPEAKING", phase, false, levels)).toBe({ starting: "connecting", ending: "ending", ended: "ended", error: "error" }[phase]);
  });
});
