/** Numeric provider observations only. Never sum snapshots as invoice charges without reconciliation. */
export function geminiUsageCounters(raw: Record<string, unknown>): Record<string, number> {
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
