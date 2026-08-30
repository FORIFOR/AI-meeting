import type { HistogramBucket, Summary } from "./types.js";

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

export function summarize(values: number[]): Summary {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.length ? sorted[sorted.length - 1]! : NaN };
}

/** Response-latency buckets (ms): 0-300, 300-500, 500-700, 700-1000, 1000-1500, 1500-2000, 2000-3000, 3000+ */
export const LATENCY_BUCKETS = [0, 300, 500, 700, 1000, 1500, 2000, 3000];

export function histogram(values: number[], edges: number[] = LATENCY_BUCKETS): HistogramBucket[] {
  const buckets: HistogramBucket[] = edges.map((from, i) => ({ from, to: i + 1 < edges.length ? edges[i + 1]! : null, count: 0 }));
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    for (let i = buckets.length - 1; i >= 0; i--) {
      if (v >= buckets[i]!.from) {
        buckets[i]!.count++;
        break;
      }
    }
  }
  return buckets;
}

/** Bounded sample store so a 30-minute soak never grows unbounded. */
export class Samples {
  private values: number[] = [];
  constructor(private readonly limit = 5000) {}
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.values.push(v);
    if (this.values.length > this.limit) this.values.splice(0, this.values.length - this.limit);
  }
  all(): number[] {
    return [...this.values];
  }
  summary(): Summary {
    return summarize(this.values);
  }
}
