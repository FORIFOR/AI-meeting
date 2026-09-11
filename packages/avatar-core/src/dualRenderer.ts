import type { PCMFrame } from "@rcai/audio-core";
import type { AvatarProvider, AvatarState, CharacterDefinition, Emotion, GazeTarget, Gesture, AvatarParams, MotionCategory } from "./types.js";

/** Two views of one character. The local view is ready before external media is selected. */
export class DualRenderer implements AvatarProvider {
  private external = false;
  private stopped = false;
  private failed = false;
  private unsubscribe?: () => void;
  constructor(private readonly options: {
    local: AvatarProvider;
    natural: AvatarProvider;
    localContainer: HTMLElement;
    naturalContainer: HTMLElement;
    onFallback?: (reason: string) => void;
  }) { this.show(false); }

  get id(): string { return this.external ? this.options.natural.id : this.options.local.id; }
  get synchronizedAudio() { return this.external ? this.options.natural.synchronizedAudio : undefined; }
  private get active() { return this.external ? this.options.natural : this.options.local; }
  private show(natural: boolean): void {
    this.options.localContainer.style.visibility = natural ? "hidden" : "visible";
    this.options.naturalContainer.style.visibility = natural ? "visible" : "hidden";
  }
  async prepare(character: CharacterDefinition): Promise<void> {
    await this.options.local.prepare(character);
    if (this.stopped) { await this.options.local.stop(); return; }
    try {
      await this.options.natural.prepare(character);
    } catch { this.useLocalFallback("connection_failed"); }
    if (this.stopped) await this.options.natural.stop();
  }
  async start(): Promise<void> {
    if (this.stopped) return;
    await this.options.local.start();
    if (this.stopped) { await this.options.local.stop(); return; }
    if (this.failed) return;
    try {
      await this.options.natural.start();
      if (this.stopped || this.failed) { await this.options.natural.stop(); return; }
      const audio = this.options.natural.synchronizedAudio;
      if (!audio?.getOutputStream()) throw new Error("missing synchronized output");
      this.unsubscribe = audio.onFailure(() => this.useLocalFallback("connection_lost"));
      this.external = true;
      this.show(true);
    } catch { this.useLocalFallback("connection_failed"); }
  }
  useLocalFallback(reason: string): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.external = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.show(false);
    // Stop immediately: passthrough has no returned-media cancellation acknowledgement.
    void this.options.natural.stop().catch(() => {});
    this.options.onFallback?.(reason);
  }
  pushAudio(frame: PCMFrame): void { this.active.pushAudio(frame); }
  setState(state: AvatarState): void {
    this.options.local.setState(state);
    if (this.external) this.options.natural.setState(state);
  }
  setEmotion(emotion: Emotion, intensity: number): void {
    this.options.local.setEmotion(emotion, intensity);
    if (this.external) this.options.natural.setEmotion(emotion, intensity);
  }
  performGesture(gesture: Gesture, intensity: number): void { this.active.performGesture(gesture, intensity); }
  setGaze(target: GazeTarget): void {
    this.options.local.setGaze(target);
    if (this.external) this.options.natural.setGaze(target);
  }
  interrupt(): void {
    this.active.interrupt();
    if (this.external) this.useLocalFallback("interrupted");
    this.options.local.interrupt();
  }
  blink(durationMs?: number): void { this.active.blink?.(durationMs); }
  setMicroMotion(params: Partial<AvatarParams>): void { this.active.setMicroMotion?.(params); }
  playMotion(category: MotionCategory, opts?: { tags?: string[]; energy?: number; clipId?: string }): void { this.active.playMotion?.(category, opts); }
  async stop(): Promise<void> {
    this.stopped = true;
    this.external = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled([this.options.local.stop(), this.options.natural.stop()]);
    this.options.localContainer.remove();
    this.options.naturalContainer.remove();
  }
}
