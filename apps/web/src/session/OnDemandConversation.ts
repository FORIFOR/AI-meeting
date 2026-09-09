import type { RealtimeAIProvider } from "@rcai/provider-core";
import type { ConversationContext, ConversationEventListener, SessionConfig } from "@rcai/conversation-core";
import type { PCMFrame, ImageFrame } from "@rcai/audio-core";

/** The independent transcript observer calls sendText when participation is warranted. */
export class OnDemandConversation implements RealtimeAIProvider {
  readonly id;
  private config: SessionConfig | null = null;
  private active = false;
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<ConversationEventListener>();
  private epoch = 0;
  constructor(private readonly inner: RealtimeAIProvider, private readonly idleMs = 30000) {
    this.id = inner.id;
    inner.onEvent(e => {
      if (!this.active && !this.opening) return;
      if (e.type === "session_ready") return;
      if (e.type === "assistant_thinking" || e.type === "assistant_speech_started" || e.type === "user_speech_started") this.arm(60000);
      if (e.type === "assistant_speech_ended" || e.type === "interrupted" || e.type === "user_speech_ended") this.arm();
      for (const cb of this.listeners) cb(e);
    });
  }
  capabilities() { return this.inner.capabilities(); }
  usageSnapshot() { return (this.inner as RealtimeAIProvider & { usageSnapshot?(): Record<string, number> }).usageSnapshot?.() ?? {}; }
  onEvent(cb: ConversationEventListener) { this.listeners.add(cb); }
  async connect(config: SessionConfig) {
    await this.disconnect();
    this.config = { ...config, providerOptions: { ...config.providerOptions, externalTranscription: true } };
    for (const cb of this.listeners) cb({ type: "session_ready", providerId: this.id });
  }
  private clearTimer() { clearTimeout(this.timer); this.timer = undefined; }
  private arm(delay = this.idleMs) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.active = false;
      void this.inner.disconnect();
    }, delay);
  }
  private async engage() {
    if (!this.config) throw new Error("Conversation observer has stopped");
    this.clearTimer();
    if (this.active) return;
    if (!this.opening) {
      const epoch = this.epoch;
      this.opening = this.inner.connect(this.config).then(() => {
        if (epoch !== this.epoch) throw new Error("Conversation cancelled");
        this.active = true;
      }).finally(() => { this.opening = null; });
    }
    await this.opening;
  }
  async sendText(text: string) { await this.engage(); this.arm(60000); await this.inner.sendText(text); }
  pushAudio(frame: PCMFrame) { if (this.active) this.inner.pushAudio(frame); }
  pushImage(image: ImageFrame) { if (this.active) this.inner.pushImage?.(image); }
  sendToolResponse(responses: Parameters<NonNullable<RealtimeAIProvider["sendToolResponse"]>>[0]) { if (this.active) this.inner.sendToolResponse?.(responses); }
  async interrupt() { if (this.active) { await this.inner.interrupt(); this.arm(); } }
  async updateContext(context: ConversationContext) {
    if (this.config) this.config = { ...this.config, systemPrompt: context.systemPrompt };
    if (this.active) await this.inner.updateContext(context);
  }
  async disconnect() {
    this.epoch++;
    this.clearTimer();
    this.active = false;
    this.config = null;
    await this.inner.disconnect();
    await this.opening?.catch(() => {});
  }
}
