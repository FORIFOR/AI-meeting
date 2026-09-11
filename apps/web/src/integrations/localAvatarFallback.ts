import type { AvatarProvider, AvatarState, CharacterDefinition, Emotion, GazeTarget, Gesture, MotionCategory, AvatarParams } from "@rcai/avatar-core";
import type { PCMFrame } from "@rcai/audio-core";

/** A failed local model stays local. It never selects a billed/cloud renderer. */
export class LocalAvatarFallback implements AvatarProvider {
  private current: AvatarProvider;
  private stopped = false;
  private fallback: AvatarProvider | null = null;
  constructor(private readonly primary: AvatarProvider, private readonly createFallback: () => Promise<AvatarProvider>, private readonly onFallback?: (reason: string) => void) {
    this.current = primary;
  }
  get id(): string { return this.current.id; }
  get stack(): unknown { return (this.current as AvatarProvider & { stack?: unknown }).stack; }
  getLipSyncDiagnostics(): unknown { return (this.current as AvatarProvider & { getLipSyncDiagnostics?: () => unknown }).getLipSyncDiagnostics?.(); }
  getRenderDiagnostics(): unknown { return (this.current as AvatarProvider & { getRenderDiagnostics?: () => unknown }).getRenderDiagnostics?.(); }
  async prepare(character: CharacterDefinition): Promise<void> {
    if (this.stopped) throw new Error("AVATAR_PREPARE_CANCELLED");
    try {
      await this.primary.prepare(character);
      if (this.stopped) { await this.primary.stop(); throw new Error("AVATAR_PREPARE_CANCELLED"); }
    } catch (error) {
      await this.primary.stop().catch(() => {});
      if (this.stopped) throw error;
      const fallback = await this.createFallback();
      this.fallback = fallback;
      if (this.stopped) { await fallback.stop(); throw new Error("AVATAR_PREPARE_CANCELLED"); }
      this.current = fallback;
      try {
        await fallback.prepare(character);
        if (this.stopped) { await fallback.stop(); throw new Error("AVATAR_PREPARE_CANCELLED"); }
      } catch (failure) { await fallback.stop().catch(() => {}); throw failure; }
      this.onFallback?.("vrm_model_unavailable");
    }
  }
  async start(): Promise<void> {
    if (this.stopped) return;
    const current = this.current;
    await current.start();
    if (this.stopped) await current.stop();
  }
  pushAudio(frame: PCMFrame): void { if (!this.stopped) this.current.pushAudio(frame); }
  setState(state: AvatarState): void { if (!this.stopped) this.current.setState(state); }
  setEmotion(emotion: Emotion, intensity: number): void { if (!this.stopped) this.current.setEmotion(emotion, intensity); }
  performGesture(gesture: Gesture, intensity: number): void { if (!this.stopped) this.current.performGesture(gesture, intensity); }
  setGaze(target: GazeTarget): void { if (!this.stopped) this.current.setGaze(target); }
  interrupt(): void { this.current.interrupt(); }
  blink(ms?: number): void { if (!this.stopped) this.current.blink?.(ms); }
  setMicroMotion(params: Partial<AvatarParams>): void { if (!this.stopped) this.current.setMicroMotion?.(params); }
  playMotion(category: MotionCategory, options?: { tags?: string[]; energy?: number; clipId?: string }): void { if (!this.stopped) this.current.playMotion?.(category, options); }
  getParams(): AvatarParams { return this.current.getParams!(); }
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([this.primary.stop(), ...(this.fallback ? [this.fallback.stop()] : [])]);
  }
}
