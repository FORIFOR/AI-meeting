import { LiveUsageAccumulator } from "../../../providers/gemini/src/usage.js";
/** Transport totals plus a public-rate estimate for completed, fully described responses. */
export class VertexUsage {
  private readonly costs = new LiveUsageAccumulator();
  private outputSeconds = 0;
  private imageCount = 0;
  private completedTurns = 0;
  constructor(private readonly model = "gemini-live-2.5-flash-native-audio") {}
  private audioBytes = 0;
  private audioSeconds = 0;
  private unrecognizedAudioChunks = 0;
  private textCharacters = 0;
  private usageSnapshots = 0;
  private latest: Record<string, number> = {};
  outbound(message: unknown) {
    if ((message as { realtimeInput?: { video?: { data?: unknown } } } | null)?.realtimeInput?.video?.data) this.imageCount++;
    const r = (message as { realtimeInput?: { audio?: { data?: unknown; mimeType?: unknown }; text?: unknown } } | null)?.realtimeInput;
    if (typeof r?.text === "string") this.textCharacters += r.text.length;
    if (typeof r?.audio?.data !== "string") return;
    const bytes = Buffer.byteLength(r.audio.data, "base64");
    this.audioBytes += bytes;
    const rate = /^audio\/pcm;rate=(\d+)$/.exec(String(r.audio.mimeType));
    const hz = Number(rate?.[1]);
    if (rate && hz >= 8000 && hz <= 96000) this.audioSeconds += bytes / (2 * hz);
    else this.unrecognizedAudioChunks++;
  }
  inbound(message: unknown) {
    const sc = (message as { serverContent?: { modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; turnComplete?: boolean; interrupted?: boolean } } | null)?.serverContent;
    for (const part of sc?.modelTurn?.parts ?? []) {
      const rate = /^audio\/pcm;rate=(\d+)$/.exec(part.inlineData?.mimeType ?? "");
      if (rate && part.inlineData?.data && Number(rate[1]) >= 8000 && Number(rate[1]) <= 96000) this.outputSeconds += Buffer.byteLength(part.inlineData.data, "base64") / (2 * Number(rate[1]));
    }
    const m = (message as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata;
    if (m && typeof m === "object") this.costs.observe(m);
    if (sc?.turnComplete || sc?.interrupted) this.costs.complete(this.model);
    if (sc?.turnComplete) this.completedTurns++;
    if (!m || typeof m !== "object") return;
    this.usageSnapshots++;
    // Explicit numeric allowlist: no transcript, audio, tools, tokens or arbitrary keys survive.
    this.latest = {};
    for (const key of ["promptTokenCount", "responseTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount"]) {
      if (typeof m[key] === "number" && Number.isSafeInteger(m[key]) && m[key] >= 0) this.latest[key] = m[key];
    }
  }
  snapshot() {
    return { sentAudioBytes: this.audioBytes, sentAudioSeconds: Math.round(this.audioSeconds * 1000) / 1000, receivedAudioSeconds: Math.round(this.outputSeconds * 1000) / 1000, sentImageCount: this.imageCount, completedTurns: this.completedTurns, contextCompressionCount: null, unrecognizedAudioChunks: this.unrecognizedAudioChunks, sentTextCharacters: this.textCharacters, usageSnapshotCount: this.usageSnapshots, latestProviderUsage: { ...this.latest }, ...this.costs.snapshot() };
  }
}
