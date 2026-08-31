import type { BrokerEnv } from "../env.js";
import { RecallApiError, RecallConfigError } from "./client.js";

/**
 * Calendar V2 lives on `/api/v2`, not the `/api/v1` surface `client.ts` binds to, so it gets its own
 * region-bound client with the same auth/retry/redaction rules.
 *
 * Verified against docs (workspace NEXT-STANDARDS, ap-northeast-1, API v1.11):
 *   GET    /api/v2/calendars/                       list calendars
 *   GET    /api/v2/calendars/{id}/                  retrieve calendar (status, platform_email, oauth_email)
 *   DELETE /api/v2/calendars/{id}/                  disconnect (cleans up scheduled bots)
 *   GET    /api/v2/calendar-events/?calendar_id=…   list events (cursor pagination via `next`)
 *   POST   /api/v2/calendar-events/{id}/bot/        schedule bot {deduplication_key, bot_config}
 *   DELETE /api/v2/calendar-events/{id}/bot/        unschedule bot
 * Rate limits: 60/min for the event list, 600/min for the bot endpoints. 409 (parallel schedule) and
 * 507 (pre-poned event, ad-hoc pool empty) are retried with backoff per the Scheduling Guide.
 */

export interface RecallCalendar {
  id: string;
  platform: string;
  status: "connecting" | "connected" | "disconnected" | string;
  platform_email?: string | null;
  oauth_email?: string | null;
  status_changes?: { status: string; created_at?: string; sub_code?: string | null }[];
  created_at?: string;
  updated_at?: string;
}

export interface RecallCalendarEventBotRef {
  bot_id: string;
  start_time?: string;
  meeting_url?: string | null;
  deduplication_key?: string;
}

export interface RecallCalendarEvent {
  id: string;
  calendar_id: string;
  start_time: string;
  end_time: string;
  platform: string;
  platform_id: string;
  ical_uid?: string;
  meeting_platform?: unknown;
  meeting_url?: string | null;
  is_deleted: boolean;
  created_at?: string;
  updated_at?: string;
  bots?: RecallCalendarEventBotRef[];
  /** Provider payload: Google Event resource / Microsoft Event resource. */
  raw?: Record<string, unknown>;
}

export interface ListEventsQuery {
  calendarId: string;
  updatedAtGte?: string;
  startTimeGte?: string;
  startTimeLte?: string;
  isDeleted?: boolean;
}

export interface CalendarClientOptions {
  apiKey: string;
  region: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
}

/** 409 = concurrent schedule for the same dedup key; 507 = ad-hoc bot pool empty (pre-poned event). */
const RETRY_STATUS = new Set([409, 429, 503, 507]);

export class RecallCalendarClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;

  constructor(private readonly opts: CalendarClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  get base(): string {
    return `https://${this.opts.region}.recall.ai/api/v2`;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Authorization: this.opts.apiKey, accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private backoffMs(attempt: number, retryAfter: string | null): number {
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000);
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 60_000));
    }
    const base = Math.min(2 ** attempt * 500, 16_000);
    return Math.round(base * (0.5 + this.random() * 0.5));
  }

  /** `absoluteUrl` follows Recall's `next` cursor URLs verbatim (guide: do not rewrite its query). */
  private async request<T>(method: string, pathOrUrl: string, body?: unknown, absoluteUrl = false): Promise<T> {
    const url = absoluteUrl ? pathOrUrl : `${this.base}${pathOrUrl}`;
    let lastDetail = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(url, {
        method,
        headers: this.headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      lastDetail = (await res.text().catch(() => "")).slice(0, 400);
      if (!RETRY_STATUS.has(res.status) || attempt === this.maxRetries) {
        throw new RecallApiError(res.status, absoluteUrl ? "(cursor)" : pathOrUrl, lastDetail);
      }
      await this.sleep(this.backoffMs(attempt, res.headers.get("retry-after")));
    }
    throw new RecallApiError(0, pathOrUrl, lastDetail);
  }

  async listCalendars(): Promise<RecallCalendar[]> {
    const out: RecallCalendar[] = [];
    let next: string | null = null;
    let page = await this.request<{ results?: RecallCalendar[]; next?: string | null }>("GET", "/calendars/");
    for (;;) {
      out.push(...(page.results ?? []));
      next = page.next ?? null;
      if (!next) break;
      page = await this.request<{ results?: RecallCalendar[]; next?: string | null }>("GET", next, undefined, true);
    }
    return out;
  }

  retrieveCalendar(calendarId: string): Promise<RecallCalendar> {
    return this.request<RecallCalendar>("GET", `/calendars/${encodeURIComponent(calendarId)}/`);
  }

  /** Disconnect: Recall immediately unschedules every bot on that calendar. */
  deleteCalendar(calendarId: string): Promise<unknown> {
    return this.request<unknown>("DELETE", `/calendars/${encodeURIComponent(calendarId)}/`);
  }

  async listEvents(q: ListEventsQuery): Promise<RecallCalendarEvent[]> {
    const params = new URLSearchParams({ calendar_id: q.calendarId });
    if (q.updatedAtGte) params.set("updated_at__gte", q.updatedAtGte);
    if (q.startTimeGte) params.set("start_time__gte", q.startTimeGte);
    if (q.startTimeLte) params.set("start_time__lte", q.startTimeLte);
    if (q.isDeleted !== undefined) params.set("is_deleted", String(q.isDeleted));

    const out: RecallCalendarEvent[] = [];
    let page = await this.request<{ results?: RecallCalendarEvent[]; next?: string | null }>("GET", `/calendar-events/?${params}`);
    for (;;) {
      out.push(...(page.results ?? []));
      const next = page.next ?? null;
      if (!next) break;
      page = await this.request<{ results?: RecallCalendarEvent[]; next?: string | null }>("GET", next, undefined, true);
    }
    return out;
  }

  /**
   * Schedule (or re-schedule) the bot for one calendar event. `meeting_url` and `join_at` are filled
   * from the event by Recall. The endpoint has no partial update: always send the whole `bot_config`.
   */
  scheduleBot(eventId: string, deduplicationKey: string, botConfig: Record<string, unknown>): Promise<RecallCalendarEvent> {
    return this.request<RecallCalendarEvent>("POST", `/calendar-events/${encodeURIComponent(eventId)}/bot/`, {
      deduplication_key: deduplicationKey,
      bot_config: botConfig,
    });
  }

  /** Unlink the bot from this event; Recall deletes the bot once no event references it. */
  unscheduleBot(eventId: string): Promise<unknown> {
    return this.request<unknown>("DELETE", `/calendar-events/${encodeURIComponent(eventId)}/bot/`);
  }
}

export function calendarClientFromEnv(env: BrokerEnv, fetchImpl?: typeof fetch): RecallCalendarClient {
  if (!env.RECALL_API_KEY) throw new RecallConfigError("BLOCKED_BY_RECALL_KEY", "set RECALL_API_KEY in services/token-broker/.env");
  return new RecallCalendarClient({ apiKey: env.RECALL_API_KEY, region: env.RECALL_REGION ?? "us-west-2", fetchImpl });
}
