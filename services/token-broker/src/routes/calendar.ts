import type { BrokerEnv } from "../env.js";
import type { RecallCalendarClient } from "../recall/calendarClient.js";
import type { CalendarStore, Override } from "../recall/calendarStore.js";
import type { CalendarSync } from "../recall/calendarSync.js";

/**
 * Calendar V2 HTTP surface.
 *
 * The OAuth callback is the *customer-owned* redirect required by the setup guide: Recall's hosted
 * setup sends the mailbox owner (and its own probe) here, and we forward exactly four parameters to
 * the regional callback. Nothing about the query is logged — no names with values, no codes, no
 * signed state, no full URL.
 */

export interface RouteResult<T> {
  status: number;
  body: T | { error: string; detail?: string };
  /** Callback route only: content type of a passthrough body. */
  contentType?: string;
}

export interface CalendarDeps {
  client: () => RecallCalendarClient;
  store: CalendarStore;
  sync: () => CalendarSync;
  fetchImpl?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
}

/** Only these four may cross to Recall (setup guide §2). */
const FORWARD_PARAMS = ["state", "code", "error", "recall_calendar_setup_probe"] as const;

export interface CallbackResult {
  status: number;
  body: string;
  contentType: string;
}

/**
 * GET /api/meeting/calendar/oauth-callback
 * Accepts `state` plus exactly one of `code`, `error`, `recall_calendar_setup_probe=1`.
 * A probe carries neither `code` nor `error` and is still valid.
 */
export async function forwardCalendarCallback(
  env: BrokerEnv,
  query: URLSearchParams,
  fetchImpl: typeof fetch,
  log: (line: Record<string, unknown>) => void = () => {},
): Promise<CallbackResult> {
  const regional = env.RECALL_CALENDAR_REGIONAL_CALLBACK_URI;
  if (!regional) {
    return {
      status: 503,
      body: "BLOCKED_BY_RECALL_CALENDAR_CALLBACK: set RECALL_CALENDAR_REGIONAL_CALLBACK_URI to the regional_callback_uri returned by the Recall setup action.",
      contentType: "text/plain; charset=utf-8",
    };
  }

  const isProbe = query.get("recall_calendar_setup_probe") === "1";
  const hasCode = query.has("code");
  const hasError = query.has("error");
  if (!isProbe && !hasCode && !hasError) {
    // Log the shape only — never the parameter values.
    log({ op: "calendar.callback", accepted: false, kind: "missing_code_error_or_probe" });
    return { status: 400, body: "invalid callback request", contentType: "text/plain; charset=utf-8" };
  }

  const forwarded = new URLSearchParams();
  for (const name of FORWARD_PARAMS) {
    const value = query.get(name);
    if (value !== null) forwarded.set(name, value);
  }

  const target = new URL(regional);
  for (const [k, v] of forwarded) target.searchParams.set(k, v);

  log({ op: "calendar.callback", accepted: true, kind: isProbe ? "probe" : hasError ? "error" : "code" });

  try {
    const res = await fetchImpl(target.toString(), { method: "GET", redirect: "follow" });
    const body = await res.text();
    return {
      status: res.status,
      body,
      contentType: res.headers.get("content-type") ?? "text/html; charset=utf-8",
    };
  } catch {
    log({ op: "calendar.callback", accepted: true, forwarded: false, kind: "regional_unreachable" });
    return { status: 502, body: "regional callback unreachable", contentType: "text/plain; charset=utf-8" };
  }
}

/** GET /api/calendar/status — connected calendars and their readiness, for the UI. */
export async function calendarStatus(env: BrokerEnv, deps: CalendarDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  try {
    const calendars = await deps.client().listCalendars();
    return {
      status: 200,
      body: {
        rule: deps.store.rule,
        calendars: calendars.map((c) => ({
          id: c.id,
          platform: c.platform,
          status: c.status,
          platformEmail: c.platform_email ?? null,
          oauthEmail: c.oauth_email ?? null,
          connected: c.status === "connected",
          /** Testing readiness: a connected calendar whose first sync produced a cursor. */
          readyForTesting: c.status === "connected" && Boolean(deps.store.syncCursor(c.id)),
        })),
        scheduled: deps.store.listScheduled().length,
      },
    };
  } catch (e) {
    return { status: 502, body: { error: "recall_calendar_status_failed", detail: detail(e) } };
  }
}

/** GET /api/calendar/events?calendar_id=… — upcoming events annotated with the opt-in decision. */
export async function calendarEvents(env: BrokerEnv, calendarId: string | undefined, deps: CalendarDeps): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  try {
    const ids = calendarId ? [calendarId] : (await deps.client().listCalendars()).filter((c) => c.status === "connected").map((c) => c.id);
    const sync = deps.sync();
    const events: Record<string, unknown>[] = [];
    for (const id of ids) {
      for (const d of await sync.upcoming(id)) {
        events.push({
          id: d.event.id,
          calendarId: id,
          title: d.event.title,
          startsAt: d.event.startsAt,
          endsAt: d.event.endsAt,
          meetingUrl: d.event.meetingUrl,
          eligible: d.eligible,
          reason: d.reason,
          matchedMarker: d.matchedMarker,
          override: deps.store.override(d.event.id),
          botId: d.botId ?? null,
        });
      }
    }
    return { status: 200, body: { rule: deps.store.rule, events } };
  } catch (e) {
    return { status: 502, body: { error: "recall_calendar_events_failed", detail: detail(e) } };
  }
}

/** POST /api/calendar/events/:id/optin | /optout — manual override, then reconcile that one event. */
export async function setEventOverride(
  env: BrokerEnv,
  eventId: string,
  value: Override | null,
  deps: CalendarDeps,
): Promise<RouteResult<Record<string, unknown>>> {
  if (!env.RECALL_API_KEY) return { status: 503, body: { error: "BLOCKED_BY_RECALL_KEY" } };
  if (!eventId) return { status: 400, body: { error: "event id required" } };
  deps.store.setOverride(eventId, value);
  try {
    // `calendar_id` is required by List Calendar Events, so look through the calendars we know:
    // the one this event was scheduled from first, then every connected calendar.
    const known = deps.store.scheduled(eventId)?.calendarId;
    const ids = known ? [known] : (await deps.client().listCalendars()).filter((c) => c.status === "connected").map((c) => c.id);
    let raw = undefined;
    for (const id of ids) {
      const events = await deps.client().listEvents({ calendarId: id, isDeleted: false });
      raw = events.find((e) => e.id === eventId);
      if (raw) break;
    }
    if (!raw) return { status: 200, body: { eventId, override: value, action: "override_saved" } };
    const decision = await deps.sync().reconcile(raw);
    return { status: 200, body: { eventId, override: value, action: decision.action, eligible: decision.eligible, reason: decision.reason, botId: decision.botId ?? null } };
  } catch (e) {
    // The override is durable even when the follow-up reconcile fails; the next sync applies it.
    return { status: 200, body: { eventId, override: value, action: "override_saved", detail: detail(e) } };
  }
}

/** GET/PUT /api/calendar/rule — the confirmed opt-in rule. */
export function getRule(deps: CalendarDeps): RouteResult<Record<string, unknown>> {
  return { status: 200, body: { rule: deps.store.rule } };
}

export function putRule(body: { markers?: unknown; leadMinutes?: unknown }, deps: CalendarDeps): RouteResult<Record<string, unknown>> {
  const markers = Array.isArray(body.markers) ? body.markers.filter((m): m is string => typeof m === "string") : undefined;
  const leadMinutes = typeof body.leadMinutes === "number" ? body.leadMinutes : undefined;
  const rule = deps.store.setRule({ ...(markers ? { markers } : {}), ...(leadMinutes !== undefined ? { leadMinutes } : {}) });
  return { status: 200, body: { rule } };
}

function detail(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 200) : "unknown_error";
}
