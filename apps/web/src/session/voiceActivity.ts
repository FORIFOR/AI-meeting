import { dbfs, rms, type PCMFrame } from "@rcai/audio-core";
import type { AvatarState } from "@rcai/avatar-core";

export type VoiceOrbState = "idle" | "listening" | "thinking" | "speaking" | "muted" | "connecting" | "ending" | "ended" | "error";
export type VoicePhase = "starting" | "live" | "ending" | "ended" | "error";
export interface VoiceLevels { input: number; output: number; playing: boolean }
export const SILENT_VOICE: VoiceLevels = Object.freeze({ input: 0, output: 0, playing: false });

/** Numbers only, in memory. Reads existing PCM; never opens, retains or sends audio. */
export class VoiceActivity {
  private input = { level: 0, at: -Infinity };
  private output = { level: 0, at: -Infinity };
  private audibleAt = -Infinity;
  constructor(private readonly clock = () => performance.now()) {}

  capture(frame: PCMFrame): void { this.input = this.measure(frame); }
  playback(frame: PCMFrame): void {
    this.output = this.measure(frame);
    if (this.output.level > 0) this.audibleAt = this.clock();
  }
  private measure(frame: PCMFrame) {
    const level = Math.max(0, Math.min(1, (dbfs(rms(frame.data)) + 60) / 45));
    return { level: Number.isFinite(level) ? level : 0, at: this.clock() };
  }
  resetInput(): void { this.input = { level: 0, at: -Infinity }; }
  resetOutput(): void { this.output = { level: 0, at: -Infinity }; this.audibleAt = -Infinity; }
  reset(): void { this.resetInput(); this.resetOutput(); }
  read(playbackActive = false): VoiceLevels {
    const now = this.clock();
    const release = (sample: { level: number; at: number }) => sample.level * Math.max(0, 1 - Math.max(0, now - sample.at - 60) / 180);
    return { input: release(this.input), output: release(this.output), playing: now - this.audibleAt < 180 || (playbackActive && Number.isFinite(this.audibleAt)) };
  }
}

export function voiceOrbState(avatar: AvatarState, phase: VoicePhase, muted: boolean, levels: VoiceLevels): VoiceOrbState {
  if (phase === "error") return "error";
  if (phase === "starting") return "connecting";
  if (phase === "ending") return "ending";
  if (phase === "ended") return "ended";
  // Playback can outlast generation. Source chunks alone never count as audible output.
  if (levels.playing) return "speaking";
  if (avatar === "THINKING" || avatar === "SPEAKING") return "thinking";
  if (muted) return "muted";
  if (avatar === "LISTENING") return "listening";
  return "idle";
}

export const VOICE_ORB_LABELS: Record<VoiceOrbState, string> = {
  idle: "話しかけてください", listening: "聞いています", thinking: "考えています",
  speaking: "話しています", muted: "マイクはミュート中", connecting: "接続しています",
  ending: "会話を終了しています", ended: "会話を終了しました", error: "会話が停止しました",
};
