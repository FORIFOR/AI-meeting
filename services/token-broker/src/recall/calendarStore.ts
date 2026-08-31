import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OPT_IN_RULE, type OptInRule } from "@rcai/meeting-core";
import { defaultDataDir } from "./store.js";

/**
 * Durable calendar-side state the Recall API does not hold for us:
 *   - the confirmed opt-in rule (markers + lead time)
 *   - per-event manual overrides (the UI's 「参加させる」/「やめる」)
 *   - the scheduling ledger: which event we scheduled, with which dedup key, and whether it is armed
 *
 * File-backed like MeetingStore (one JSON, atomic tmp+rename) — the repo has no database.
 */

export type Override = "opt_in" | "opt_out";

export interface ScheduledEntry {
  eventId: string;
  calendarId: string;
  botId?: string;
  deduplicationKey: string;
  /** Event start we scheduled against; a change means the event moved and must be re-scheduled. */
  startsAt: string;
  meetingUrl: string;
  /** Meeting record id in MeetingStore (created before the schedule call). */
  meetingRecordId?: string;
  /** Set once the full bot_config (relay + bot page tokens) has been pushed near the start. */
  armedAt?: string;
  updatedAt: string;
}

interface CalendarStateFile {
  rule: OptInRule;
  overrides: Record<string, Override>;
  scheduled: Record<string, ScheduledEntry>;
  /** Per-calendar high-water mark for `updated_at__gte` sync queries. */
  syncCursors: Record<string, string>;
}

const EMPTY: CalendarStateFile = { rule: DEFAULT_OPT_IN_RULE, overrides: {}, scheduled: {}, syncCursors: {} };

export class CalendarStore {
  private readonly file: string;
  private state: CalendarStateFile;

  constructor(dir: string = defaultDataDir(), private readonly now: () => number = Date.now) {
    const root = join(dir, "calendar");
    mkdirSync(root, { recursive: true });
    this.file = join(root, "state.json");
    let loaded: Partial<CalendarStateFile> = {};
    try {
      loaded = JSON.parse(readFileSync(this.file, "utf8")) as Partial<CalendarStateFile>;
    } catch {
      /* first run */
    }
    this.state = {
      rule: { ...EMPTY.rule, ...(loaded.rule ?? {}) },
      overrides: loaded.overrides ?? {},
      scheduled: loaded.scheduled ?? {},
      syncCursors: loaded.syncCursors ?? {},
    };
  }

  private persist(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.file);
  }

  get rule(): OptInRule {
    return this.state.rule;
  }

  setRule(patch: Partial<OptInRule>): OptInRule {
    const markers = (patch.markers ?? this.state.rule.markers).map((m: string) => m.trim()).filter(Boolean);
    const leadMinutes = Number.isFinite(patch.leadMinutes) ? Math.max(0, Number(patch.leadMinutes)) : this.state.rule.leadMinutes;
    this.state.rule = { markers: markers.length ? markers : DEFAULT_OPT_IN_RULE.markers, leadMinutes, skipPast: true };
    this.persist();
    return this.state.rule;
  }

  override(eventId: string): Override | null {
    return this.state.overrides[eventId] ?? null;
  }

  setOverride(eventId: string, value: Override | null): void {
    if (value) this.state.overrides[eventId] = value;
    else delete this.state.overrides[eventId];
    this.persist();
  }

  scheduled(eventId: string): ScheduledEntry | null {
    return this.state.scheduled[eventId] ?? null;
  }

  listScheduled(): ScheduledEntry[] {
    return Object.values(this.state.scheduled);
  }

  markScheduled(entry: Omit<ScheduledEntry, "updatedAt">): ScheduledEntry {
    const next: ScheduledEntry = { ...entry, updatedAt: new Date(this.now()).toISOString() };
    this.state.scheduled[entry.eventId] = next;
    this.persist();
    return next;
  }

  markArmed(eventId: string): void {
    const entry = this.state.scheduled[eventId];
    if (!entry) return;
    entry.armedAt = new Date(this.now()).toISOString();
    entry.updatedAt = entry.armedAt;
    this.persist();
  }

  clearScheduled(eventId: string): void {
    delete this.state.scheduled[eventId];
    this.persist();
  }

  syncCursor(calendarId: string): string | null {
    return this.state.syncCursors[calendarId] ?? null;
  }

  setSyncCursor(calendarId: string, iso: string): void {
    this.state.syncCursors[calendarId] = iso;
    this.persist();
  }
}
