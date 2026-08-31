import { detectPlatform } from "./types.js";

/**
 * Calendar recording opt-in rule (Recall onboarding guide: "Before scheduling bots from a calendar,
 * define and confirm the product's recording opt-in rule. Connecting a calendar authorizes event
 * sync; it does not by itself authorize sending bots to every eligible meeting.")
 *
 * Confirmed with the user for this product: **marker-in-title**. A bot is scheduled only when the
 * event title carries an explicit marker (`#yui` / `#rehearsal` by default). Everything else is
 * skipped with a machine-readable reason, so nothing is recorded by accident.
 *
 * Pure and side-effect free: `services/token-broker` decides, this module only judges.
 */

/** Normalised calendar event — mapped from Recall's `/api/v2/calendar-events/` result. */
export interface SchedulableEvent {
  /** Recall calendar event UUID. */
  id: string;
  title: string;
  /** ISO-8601 start (Recall `start_time`). */
  startsAt: string;
  /** ISO-8601 end (Recall `end_time`). */
  endsAt?: string;
  /** Recall `meeting_url`; absent when the invite has no joinable link. */
  meetingUrl?: string | null;
  /** Provider said the event was cancelled (Google `status: "cancelled"`). */
  isCancelled?: boolean;
  /** Recall `is_deleted` — removed from the calendar. */
  isDeleted?: boolean;
  /** The connected mailbox organises this event. Not required by the rule; kept for future rules. */
  organizerSelf?: boolean;
}

export interface OptInRule {
  /** Case-insensitive title markers. `#` may be half- or full-width. */
  markers: string[];
  /** An event starting within this many minutes is too close to schedule reliably. */
  leadMinutes: number;
  /** Never schedule an event that already started. Always true for this product. */
  skipPast: true;
}

export const DEFAULT_OPT_IN_RULE: OptInRule = {
  markers: ["#yui", "#rehearsal"],
  // Recall recommends changing a scheduled bot no later than ~10 min before the start.
  leadMinutes: 10,
  skipPast: true,
};

export type SkipReason =
  | "deleted"
  | "cancelled"
  | "no_meeting_url"
  | "unsupported_platform"
  | "already_started"
  | "starts_too_soon"
  | "invalid_start_time"
  | "no_marker"
  | "opted_out";

export type EligibleReason = "marker_matched" | "manual_opt_in";

export interface Decision {
  eligible: boolean;
  reason: EligibleReason | SkipReason;
  /** The marker that matched, for the UI ("#yui のため参加します"). */
  matchedMarker?: string;
}

/**
 * Full-width `＃`, full-width latin letters and NBSP all appear in Japanese calendar titles when the
 * organiser types on a JP IME. Fold them so `＃ＹＵＩ` matches `#yui`.
 */
export function normalizeTitle(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/ /g, " ")
    .toLowerCase();
}

function markerHit(title: string, markers: string[]): string | null {
  const hay = normalizeTitle(title);
  for (const raw of markers) {
    const marker = normalizeTitle(raw).trim();
    if (marker && hay.includes(marker)) return raw;
  }
  return null;
}

export interface DecideInput {
  event: SchedulableEvent;
  rule: OptInRule;
  /** Manual override from the UI; wins over the marker rule in both directions. */
  override?: "opt_in" | "opt_out" | null;
  /** Evaluation time (ms). Injected so tests are deterministic. */
  now: number;
}

/**
 * Decide whether a bot should be scheduled for one calendar event.
 * Order matters: a deleted/cancelled/past event is never eligible, even with a manual opt-in.
 */
export function decideEvent({ event, rule, override, now }: DecideInput): Decision {
  if (event.isDeleted) return { eligible: false, reason: "deleted" };
  if (event.isCancelled) return { eligible: false, reason: "cancelled" };

  const startMs = Date.parse(event.startsAt);
  if (!Number.isFinite(startMs)) return { eligible: false, reason: "invalid_start_time" };

  // Compare absolute instants: Date.parse handles the offset, so DST and timezone shifts are safe.
  if (rule.skipPast && startMs <= now) return { eligible: false, reason: "already_started" };
  if (startMs - now < rule.leadMinutes * 60_000) return { eligible: false, reason: "starts_too_soon" };

  const url = event.meetingUrl?.trim();
  if (!url) return { eligible: false, reason: "no_meeting_url" };
  if (detectPlatform(url) === "unknown") return { eligible: false, reason: "unsupported_platform" };

  if (override === "opt_out") return { eligible: false, reason: "opted_out" };
  if (override === "opt_in") return { eligible: true, reason: "manual_opt_in" };

  const marker = markerHit(event.title ?? "", rule.markers);
  if (!marker) return { eligible: false, reason: "no_marker" };
  return { eligible: true, reason: "marker_matched", matchedMarker: marker };
}

/**
 * Recall's recommended "deduplicate all" key: one bot per (start time, meeting URL) across every
 * connected calendar in the workspace. Must stay stable for the life of the integration.
 */
export function deduplicationKey(event: Pick<SchedulableEvent, "startsAt" | "meetingUrl">): string {
  return `${event.startsAt}-${event.meetingUrl ?? ""}`;
}

/** Human-readable reason for the UI (Japanese, no technical codes). */
export const REASON_JA: Record<EligibleReason | SkipReason, string> = {
  marker_matched: "合図語がタイトルにあります",
  manual_opt_in: "手動で参加させる設定です",
  deleted: "予定が削除されています",
  cancelled: "予定がキャンセルされています",
  no_meeting_url: "会議URLがありません",
  unsupported_platform: "対応していない会議URLです",
  already_started: "すでに開始しています",
  starts_too_soon: "開始が近すぎます",
  invalid_start_time: "開始時刻が不正です",
  no_marker: "タイトルに合図語がありません",
  opted_out: "手動で除外されています",
};
