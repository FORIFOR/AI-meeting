/** Operational measurements only. Usage snapshots are never summed into invoice charges. */
export class VertexUsage {
  private audioBytes = 0;
  private audioSeconds = 0;
  private unrecognizedAudioChunks = 0;
  private textCharacters = 0;
  private usageSnapshots = 0;
  private latest: Record<string, number> = {};
  outbound(message: unknown) {
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
    const m = (message as { usageMetadata?: Record<string, unknown> } | null)?.usageMetadata;
    if (!m || typeof m !== "object") return;
    this.usageSnapshots++;
    // Explicit numeric allowlist: no transcript, audio, tools, tokens or arbitrary keys survive.
    this.latest = {};
    for (const key of ["promptTokenCount", "responseTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount"]) {
      if (typeof m[key] === "number" && Number.isSafeInteger(m[key]) && m[key] >= 0) this.latest[key] = m[key];
    }
  }
  snapshot() {
    return { sentAudioBytes: this.audioBytes, sentAudioSeconds: Math.round(this.audioSeconds * 1000) / 1000, unrecognizedAudioChunks: this.unrecognizedAudioChunks, sentTextCharacters: this.textCharacters, usageSnapshotCount: this.usageSnapshots, latestProviderUsage: { ...this.latest } };
  }
}
