/**
 * Bot state, ordered.
 *
 * Webhooks are the product's only source of bot state — nothing in the normal path polls Recall. That
 * makes two properties load-bearing:
 *
 *  - **Idempotent**: the same delivery must not change anything the second time. Recall retries, and the
 *    queue already de-duplicates on `webhook-id`; this is the second line.
 *  - **Monotonic**: deliveries arrive out of order (we watched `in_call_recording` land before
 *    `in_call_not_recording`), and a late earlier event must not drag a live meeting back to "joining".
 *
 * `fatal` is the exception: it is terminal whenever it arrives, because it is the one state a person has
 * to act on.
 */
export const BOT_STATUS_RANK: Record<string, number> = {
  intent: 0,
  creating: 1,
  joining_call: 2,
  in_waiting_room: 3,
  in_call_not_recording: 4,
  in_call_recording: 5,
  call_ended: 6,
  done: 7,
  fatal: 8,
  create_failed: 8,
  left: 6,
};

export function rankOf(status: string | null | undefined): number {
  return BOT_STATUS_RANK[status ?? ""] ?? -1;
}

/** Whether `next` should replace `current`, given deliveries can arrive in any order. */
export function shouldApplyStatus(current: string | null | undefined, next: string): boolean {
  if (next === "fatal") return current !== "fatal";
  const from = rankOf(current);
  const to = rankOf(next);
  if (to < 0) return false; // unknown status: keep what we had, but the event is still recorded
  if (from < 0) return true;
  return to > from;
}

/** One line per delivery, for tracing a meeting without opening the payloads (which carry tokens). */
export interface BotStateObservation {
  botId: string | null;
  meetingId: string | null;
  eventId: string | null;
  event: string;
  status: string | null;
  subCode: string | null;
  receivedAt: number;
  /** ms between Recall stamping the status change and us processing it; null when unstamped. */
  transitionLatencyMs: number | null;
  applied: boolean;
  reason: "applied" | "out_of_order" | "duplicate" | "unknown_status" | "no_record";
}

export function observation(o: Omit<BotStateObservation, "transitionLatencyMs"> & { updatedAt?: string | null }): BotStateObservation {
  const stamped = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
  const { updatedAt: _ignored, ...rest } = o;
  return { ...rest, transitionLatencyMs: Number.isFinite(stamped) ? o.receivedAt - stamped : null };
}
