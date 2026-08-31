import {
  decideEvent,
  deduplicationKey,
  type Decision,
  type SchedulableEvent,
} from "@rcai/meeting-core";
import type { RecallCalendarClient, RecallCalendarEvent } from "./calendarClient.js";
import type { CalendarStore } from "./calendarStore.js";
import type { MeetingStore } from "./store.js";

/**
 * Calendar → bot scheduling (Recall Scheduling Guide).
 *
 * `calendar.sync_events` → List Calendar Events with `updated_at__gte` → apply the confirmed opt-in
 * rule → Schedule Bot For Calendar Event / Delete Bot From Calendar Event. Recall overrides a
 * previously scheduled bot when the same event is scheduled again, so a re-sync never double-books.
 *
 * Two-phase config, because `bot_page` session tokens live 15 minutes but an event may be days away:
 *   1. sync time  — schedule the bot with a minimal config (name only) to reserve it and link the event;
 *   2. arm time   — shortly before the start, re-schedule with the full config (relay websocket +
 *                   Output Media page URL) using freshly issued tokens. Recall applies the newest
 *                   config, and the guide asks for changes ≥10 min before the start.
 */

export interface BotConfigFactory {
  /** Minimal config used when the bot is reserved far ahead of the meeting. */
  reserve(event: SchedulableEvent): Record<string, unknown>;
  /**
   * Full config with fresh, short-lived tokens, applied near the start.
   * `null` means the broker cannot arm yet (missing public URLs) — the reservation stays as is.
   */
  arm(event: SchedulableEvent, meetingRecordId?: string): Record<string, unknown> | null;
}

export interface CalendarSyncDeps {
  client: RecallCalendarClient;
  calendarStore: CalendarStore;
  meetingStore?: MeetingStore;
  botConfig: BotConfigFactory;
  now?: () => number;
  log?: (line: Record<string, unknown>) => void;
  /** How long before the start the full config is pushed. Default 12 min (guide: ≥10). */
  armWindowMinutes?: number;
}

export interface EventDecision extends Decision {
  event: SchedulableEvent;
  action: "scheduled" | "rescheduled" | "unscheduled" | "unchanged" | "skipped" | "failed";
  botId?: string;
  error?: string;
}

/** Recall event → the shape the pure rule engine judges. `raw.status` carries Google's cancellation. */
export function toSchedulable(e: RecallCalendarEvent): SchedulableEvent {
  const raw = (e.raw ?? {}) as { summary?: string; subject?: string; status?: string; isCancelled?: boolean };
  return {
    id: e.id,
    title: raw.summary ?? raw.subject ?? "",
    startsAt: e.start_time,
    endsAt: e.end_time,
    meetingUrl: e.meeting_url ?? null,
    isDeleted: e.is_deleted === true,
    isCancelled: raw.status === "cancelled" || raw.isCancelled === true,
  };
}

export class CalendarSync {
  private readonly now: () => number;
  private readonly log: (line: Record<string, unknown>) => void;
  private readonly armWindowMs: number;

  constructor(private readonly deps: CalendarSyncDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.armWindowMs = (deps.armWindowMinutes ?? 12) * 60_000;
  }

  /** Re-fetch changed events for one calendar and reconcile every one of them. */
  async syncCalendar(calendarId: string, updatedSince?: string): Promise<EventDecision[]> {
    const { client, calendarStore } = this.deps;
    const since = updatedSince ?? calendarStore.syncCursor(calendarId) ?? undefined;
    const events = await client.listEvents({ calendarId, updatedAtGte: since });
    const out: EventDecision[] = [];
    // Chronological order keeps the most imminent events inside the endpoint's rate limit first.
    for (const raw of [...events].sort((a, b) => a.start_time.localeCompare(b.start_time))) {
      out.push(await this.reconcile(raw));
    }
    const latest = events.map((e) => e.updated_at ?? "").filter(Boolean).sort().at(-1);
    if (latest) calendarStore.setSyncCursor(calendarId, latest);
    this.log({ op: "calendar.sync", calendarId, events: events.length, scheduled: out.filter((d) => d.action === "scheduled" || d.action === "rescheduled").length });
    return out;
  }

  /** Decide + act for one event. Safe to call repeatedly: it converges, it does not duplicate. */
  async reconcile(raw: RecallCalendarEvent): Promise<EventDecision> {
    const { calendarStore, client, meetingStore, botConfig } = this.deps;
    const event = toSchedulable(raw);
    const decision = decideEvent({
      event,
      rule: calendarStore.rule,
      override: calendarStore.override(event.id),
      now: this.now(),
    });
    const existing = calendarStore.scheduled(event.id);

    if (!decision.eligible) {
      if (!existing) return { ...decision, event, action: "skipped" };
      // Deleted events are unscheduled by Recall automatically; releasing our ledger is enough.
      if (!event.isDeleted) {
        try {
          await client.unscheduleBot(event.id);
        } catch (e) {
          return { ...decision, event, action: "failed", error: reason(e) };
        }
      }
      calendarStore.clearScheduled(event.id);
      if (existing.meetingRecordId && meetingStore) meetingStore.update(existing.meetingRecordId, { status: "left" }, `calendar_unscheduled:${decision.reason}`);
      this.log({ op: "calendar.unschedule", event: event.id, reason: decision.reason });
      return { ...decision, event, action: "unscheduled", botId: existing.botId };
    }

    const key = deduplicationKey(event);
    const moved = existing && (existing.startsAt !== event.startsAt || existing.meetingUrl !== (event.meetingUrl ?? ""));
    if (existing && !moved) return { ...decision, event, action: "unchanged", botId: existing.botId };

    const record = meetingStore
      ? existing?.meetingRecordId
        ? meetingStore.get(existing.meetingRecordId)
        : meetingStore.createIntent({
            meetingUrl: event.meetingUrl!,
            source: "calendar",
            calendarEventId: event.id,
            scheduledFor: event.startsAt,
          })
      : null;

    try {
      const updated = await client.scheduleBot(event.id, key, botConfig.reserve(event));
      const botId = updated.bots?.[0]?.bot_id;
      calendarStore.markScheduled({
        eventId: event.id,
        calendarId: raw.calendar_id,
        botId,
        deduplicationKey: key,
        startsAt: event.startsAt,
        meetingUrl: event.meetingUrl!,
        meetingRecordId: record?.id,
      });
      if (record && botId) meetingStore?.update(record.id, { botId, scheduledFor: event.startsAt }, moved ? "calendar_rescheduled" : "calendar_scheduled");
      this.log({ op: moved ? "calendar.reschedule" : "calendar.schedule", event: event.id, bot: botId ?? null });
      return { ...decision, event, action: moved ? "rescheduled" : "scheduled", botId };
    } catch (e) {
      this.log({ op: "calendar.schedule_failed", event: event.id, error: reason(e) });
      return { ...decision, event, action: "failed", error: reason(e) };
    }
  }

  /**
   * Push the full bot config (fresh relay + Output Media tokens) for events starting soon.
   * Call on a timer; it is idempotent per event thanks to `armedAt`.
   */
  async armDueEvents(): Promise<{ eventId: string; armed: boolean; error?: string }[]> {
    const { calendarStore, client, botConfig } = this.deps;
    const now = this.now();
    const out: { eventId: string; armed: boolean; error?: string }[] = [];
    for (const entry of calendarStore.listScheduled()) {
      if (entry.armedAt) continue;
      const startMs = Date.parse(entry.startsAt);
      if (!Number.isFinite(startMs) || startMs - now > this.armWindowMs || startMs < now) continue;
      const event: SchedulableEvent = { id: entry.eventId, title: "", startsAt: entry.startsAt, meetingUrl: entry.meetingUrl };
      const config = botConfig.arm(event, entry.meetingRecordId);
      if (!config) {
        out.push({ eventId: entry.eventId, armed: false, error: "BLOCKED_BY_RECALL_PUBLIC_URL" });
        continue;
      }
      try {
        await client.scheduleBot(entry.eventId, entry.deduplicationKey, config);
        calendarStore.markArmed(entry.eventId);
        this.log({ op: "calendar.arm", event: entry.eventId });
        out.push({ eventId: entry.eventId, armed: true });
      } catch (e) {
        this.log({ op: "calendar.arm_failed", event: entry.eventId, error: reason(e) });
        out.push({ eventId: entry.eventId, armed: false, error: reason(e) });
      }
    }
    return out;
  }

  /** Upcoming events for the UI, annotated with the rule decision. */
  async upcoming(calendarId: string, days = 28): Promise<(EventDecision & { botId?: string })[]> {
    const now = this.now();
    const events = await this.deps.client.listEvents({
      calendarId,
      isDeleted: false,
      startTimeGte: new Date(now).toISOString(),
      startTimeLte: new Date(now + days * 86_400_000).toISOString(),
    });
    return events
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
      .map((raw) => {
        const event = toSchedulable(raw);
        const decision = decideEvent({ event, rule: this.deps.calendarStore.rule, override: this.deps.calendarStore.override(event.id), now });
        return { ...decision, event, action: "unchanged" as const, botId: this.deps.calendarStore.scheduled(event.id)?.botId ?? raw.bots?.[0]?.bot_id };
      });
  }
}

/**
 * Dispatch a verified Calendar V2 dashboard webhook.
 *   calendar.sync_events { calendar_id, last_updated_ts } → re-sync from that timestamp
 *   calendar.update      { calendar_id }                  → re-read the calendar; a disconnect drops our ledger
 * Exported so the shared webhook worker can route `calendar.*` here (nothing else in the payload is
 * logged: calendar ids only, never emails or event titles).
 */
export async function handleCalendarWebhook(
  envelope: { event?: string; data?: { calendar_id?: string; last_updated_ts?: string } },
  sync: CalendarSync,
  deps: { client: RecallCalendarClient; calendarStore: CalendarStore; log?: (l: Record<string, unknown>) => void },
): Promise<void> {
  const log = deps.log ?? (() => {});
  const calendarId = envelope.data?.calendar_id;
  if (!calendarId) throw new Error(`${envelope.event ?? "calendar.*"} without data.calendar_id`);

  if (envelope.event === "calendar.sync_events") {
    await sync.syncCalendar(calendarId, envelope.data?.last_updated_ts);
    return;
  }

  if (envelope.event === "calendar.update") {
    const cal = await deps.client.retrieveCalendar(calendarId);
    if (cal.status === "disconnected") {
      // Recall removes every bot for a disconnected calendar; drop our ledger so nothing is re-armed.
      for (const entry of deps.calendarStore.listScheduled()) {
        if (entry.calendarId === calendarId) deps.calendarStore.clearScheduled(entry.eventId);
      }
      log({ op: "calendar.disconnected", calendarId });
    } else {
      log({ op: "calendar.updated", calendarId, status: cal.status });
    }
    return;
  }

  log({ op: "calendar.unhandled", event: envelope.event ?? null });
}

export function isCalendarEvent(event: string | undefined): boolean {
  return typeof event === "string" && event.startsWith("calendar.");
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : "unknown_error";
}
