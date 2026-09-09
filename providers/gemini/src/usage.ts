/** Numeric provider observations only. Never sum snapshots as invoice charges without reconciliation. */
export function geminiUsageCounters(raw: Record<string, unknown>): Record<string, number> {
  raw = { ...raw, responseTokenCount: raw.responseTokenCount ?? raw.candidatesTokenCount, responseTokensDetails: raw.responseTokensDetails ?? raw.candidatesTokensDetails };
  const counters: Record<string, number> = {};
  const put = (key: string, value: unknown) => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counters[key] = value;
  };
  for (const [wire, name] of Object.entries({ promptTokenCount: 'input', responseTokenCount: 'output', totalTokenCount: 'total', cachedContentTokenCount: 'cached', thoughtsTokenCount: 'reasoning', toolUsePromptTokenCount: 'toolInput' })) put(name, raw[wire]);
  for (const [wire, prefix] of Object.entries({ promptTokensDetails: 'input', responseTokensDetails: 'output', cacheTokensDetails: 'cached' })) {
    const values = raw[wire];
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (!item || typeof item !== 'object') continue;
      const { modality, tokenCount } = item as Record<string, unknown>;
      // Short categorical identifiers; these keys also survive the content-redaction layer.
      const code = ({ TEXT: 'txt', AUDIO: 'snd', VIDEO: 'vid', IMAGE: 'img' } as Record<string, string>)[String(modality)];
      if (code) put(`${prefix}_${code}`, tokenCount);
    }
  }
  return counters;
}

/** Replace interim metadata, price once at the response boundary. Never sum checkpoints. */
export class LiveUsageAccumulator {
  private pending: Record<string, number> | null = null;
  private microUsd = 0;
  private priced = 0;
  private unknown = 0;
  private peak = 0;
  observe(raw: Record<string, unknown>) {
    this.pending = geminiUsageCounters(raw);
    this.peak = Math.max(this.peak, this.pending.input ?? 0);
  }
  complete(model: string) {
    const c = this.pending; this.pending = null;
    if (!c) return false;
    const supported = /gemini-live-2\.5-flash(?:-native-audio)?$/.test(model);
    const input = (c.input_txt ?? 0) + (c.input_snd ?? 0) + (c.input_img ?? 0) + (c.input_vid ?? 0);
    const output = (c.output_txt ?? 0) + (c.output_snd ?? 0);
    // Missing modality breakdown is unknown, never a zero-dollar turn.
    const outputTotal = c.output ?? ((c.total ?? 0) - (c.input ?? 0));
    if (!supported || c.input === undefined || input !== c.input || output !== outputTotal || (c.cached ?? 0) > 0) { this.unknown++; return true; }
    this.microUsd += (c.input_txt ?? 0) * .5 + ((c.input_snd ?? 0) + (c.input_img ?? 0) + (c.input_vid ?? 0)) * 3 + (c.output_txt ?? 0) * 2 + (c.output_snd ?? 0) * 12;
    this.priced++;
    return true;
  }
  snapshot() { return { estimatedMicroUsd: this.microUsd, pricedTurns: this.priced, unpricedTurns: this.unknown, contextPeakTokens: this.peak }; }
}
