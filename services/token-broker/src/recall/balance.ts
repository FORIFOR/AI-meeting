import type { BrokerEnv } from "../env.js";

/**
 * Recall bot usage, cached.
 *
 * Running out of credit does not fail loudly: bots already in a call finish, and the next `POST /bot`
 * answers 402 — a support ticket that looks like an outage. The public billing endpoint reports usage but
 * NOT the remaining credit balance, so this is a consumption trend, not a balance. The operational signals
 * that do exist are `BLOCKED_BY_RECALL_CREDIT` on create (mapped from 402) and auto top-up, which is a
 * dashboard setting rather than an API one.
 *
 * Rate limited to 5 requests per minute, hence the cache.
 */
export interface RecallUsage {
  /** Billed bot hours in the window. */
  botHours: number;
  windowDays: number;
  /** The public API does not expose remaining credit; say so rather than imply a balance of zero. */
  remainingCredit: "not_exposed_by_api";
  checkedAt: number;
}

const CACHE_MS = 60_000;
let cached: { at: number; value: RecallUsage } | null = null;

export async function recallUsage(env: BrokerEnv, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, windowDays = 30): Promise<RecallUsage | { error: string; detail?: string }> {
  if (!env.RECALL_API_KEY) return { error: "BLOCKED_BY_RECALL_KEY" };
  if (cached && now() - cached.at < CACHE_MS) return cached.value;
  const region = env.RECALL_REGION ?? "us-west-2";
  const day = (offsetMs: number) => new Date(now() + offsetMs).toISOString().slice(0, 10);
  // The trailing slash matters: without it Recall answers 301 and the body is not JSON.
  const url = `https://${region}.recall.ai/api/v1/billing/usage/?start_date=${day(-windowDays * 86_400_000)}&end_date=${day(86_400_000)}&granularity=day`;
  const res = await fetchImpl(url, { headers: { Authorization: env.RECALL_API_KEY, accept: "application/json" } });
  if (!res.ok) return { error: "recall_usage_failed", detail: String(res.status) };
  const body = (await res.json().catch(() => ({}))) as { bot_total?: number | string };
  // `bot_total` is seconds: 14053.27 over this window matched 3.90 billed hours exactly.
  const value: RecallUsage = {
    botHours: Math.round((Number(body.bot_total ?? 0) / 3600) * 100) / 100,
    windowDays,
    remainingCredit: "not_exposed_by_api",
    checkedAt: now(),
  };
  cached = { at: now(), value };
  return value;
}

/** Test seam: the cache is process-wide. */
export function resetRecallUsageCache(): void {
  cached = null;
}
