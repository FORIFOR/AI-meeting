import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerEnv } from "../env.js";
import { CalendarStore } from "./calendarStore.js";
import { RecallCalendarClient, type RecallCalendarEvent } from "./calendarClient.js";
import { CalendarSync, handleCalendarWebhook, isCalendarEvent, toSchedulable } from "./calendarSync.js";
import { forwardCalendarCallback } from "../routes/calendar.js";
import { MeetingStore } from "./store.js";

const NOW = Date.parse("2026-09-01T09:00:00+09:00");
const later = (min: number) => new Date(NOW + min * 60_000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rcai-cal-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function event(patch: Partial<RecallCalendarEvent> & { title?: string } = {}): RecallCalendarEvent {
  const { title = "定例 #yui", ...rest } = patch;
  return {
    id: "evt_1",
    calendar_id: "cal_1",
    start_time: later(60),
    end_time: later(90),
    platform: "google_calendar",
    platform_id: "g1",
    meeting_url: "https://meet.google.com/abc-defg-hij",
    is_deleted: false,
    updated_at: "2026-09-01T00:00:00Z",
    raw: { summary: title },
    ...rest,
  };
}

/** Recording fake for the v2 client. */
function fakeClient(events: RecallCalendarEvent[]) {
  const calls: { op: string; args: unknown[] }[] = [];
  const client = {
    listEvents: vi.fn(async () => events),
    listCalendars: vi.fn(async () => [{ id: "cal_1", platform: "google_calendar", status: "connected", platform_email: "a@example.com" }]),
    retrieveCalendar: vi.fn(async () => ({ id: "cal_1", platform: "google_calendar", status: "connected" })),
    scheduleBot: vi.fn(async (id: string, key: string, cfg: Record<string, unknown>) => {
      calls.push({ op: "schedule", args: [id, key, cfg] });
      return { ...events.find((e) => e.id === id)!, bots: [{ bot_id: "bot_1", deduplication_key: key }] };
    }),
    unscheduleBot: vi.fn(async (id: string) => {
      calls.push({ op: "unschedule", args: [id] });
      return {};
    }),
  };
  return { client: client as unknown as RecallCalendarClient, calls, spies: client };
}

function makeSync(events: RecallCalendarEvent[], armable = true) {
  const { client, spies } = fakeClient(events);
  const calendarStore = new CalendarStore(dir, () => NOW);
  const meetingStore = new MeetingStore(dir, () => NOW);
  const sync = new CalendarSync({
    client,
    calendarStore,
    meetingStore,
    now: () => NOW,
    botConfig: {
      reserve: () => ({ bot_name: "Yui" }),
      arm: () => (armable ? { bot_name: "Yui", output_media: { camera: {} } } : null),
    },
  });
  return { sync, calendarStore, meetingStore, spies };
}

describe("calendar sync — scheduling", () => {
  it("schedules a bot for an eligible marked event and persists the intent first", async () => {
    const { sync, calendarStore, meetingStore, spies } = makeSync([event()]);
    const [d] = await sync.syncCalendar("cal_1");
    expect(d).toMatchObject({ action: "scheduled", eligible: true, botId: "bot_1" });
    expect(spies.scheduleBot).toHaveBeenCalledTimes(1);
    const entry = calendarStore.scheduled("evt_1")!;
    expect(entry.deduplicationKey).toBe(`${later(60)}-https://meet.google.com/abc-defg-hij`);
    const rec = meetingStore.get(entry.meetingRecordId!)!;
    expect(rec).toMatchObject({ source: "calendar", calendarEventId: "evt_1", botId: "bot_1" });
    expect(rec.lifecycle[0]!.event).toBe("intent");
  });

  it("does not double-book when the same event syncs again", async () => {
    const { sync, spies } = makeSync([event()]);
    await sync.syncCalendar("cal_1");
    const second = await sync.syncCalendar("cal_1");
    expect(second[0]).toMatchObject({ action: "unchanged", botId: "bot_1" });
    expect(spies.scheduleBot).toHaveBeenCalledTimes(1);
  });

  it("re-schedules (not duplicates) when the event moves", async () => {
    const evt = event();
    const { sync, spies, calendarStore } = makeSync([evt]);
    await sync.syncCalendar("cal_1");
    evt.start_time = later(180);
    const [d] = await sync.syncCalendar("cal_1");
    expect(d!.action).toBe("rescheduled");
    expect(spies.scheduleBot).toHaveBeenCalledTimes(2);
    expect(spies.unscheduleBot).not.toHaveBeenCalled();
    expect(calendarStore.scheduled("evt_1")!.startsAt).toBe(later(180));
  });

  it("skips an unmarked event without calling Recall", async () => {
    const { sync, spies } = makeSync([event({ title: "顧客定例" })]);
    const [d] = await sync.syncCalendar("cal_1");
    expect(d).toMatchObject({ action: "skipped", eligible: false, reason: "no_marker" });
    expect(spies.scheduleBot).not.toHaveBeenCalled();
  });

  it("skips a past event and a link-less event", async () => {
    const { sync, spies } = makeSync([
      event({ id: "past", start_time: later(-30) }),
      event({ id: "nolink", meeting_url: null }),
    ]);
    const decisions = await sync.syncCalendar("cal_1");
    expect(decisions.map((d) => d.reason).sort()).toEqual(["already_started", "no_meeting_url"]);
    expect(spies.scheduleBot).not.toHaveBeenCalled();
  });

  it("advances the sync cursor to the newest updated_at", async () => {
    const { sync, calendarStore } = makeSync([event({ updated_at: "2026-09-01T00:00:00Z" }), event({ id: "e2", updated_at: "2026-09-01T05:00:00Z", title: "no marker" })]);
    await sync.syncCalendar("cal_1");
    expect(calendarStore.syncCursor("cal_1")).toBe("2026-09-01T05:00:00Z");
  });
});

describe("calendar sync — cancellation", () => {
  it("unschedules when the marker is removed from the title", async () => {
    const evt = event();
    const { sync, spies, calendarStore } = makeSync([evt]);
    await sync.syncCalendar("cal_1");
    evt.raw = { summary: "定例" };
    const [d] = await sync.syncCalendar("cal_1");
    expect(d).toMatchObject({ action: "unscheduled", reason: "no_marker" });
    expect(spies.unscheduleBot).toHaveBeenCalledWith("evt_1");
    expect(calendarStore.scheduled("evt_1")).toBeNull();
  });

  it("unschedules when the event is cancelled", async () => {
    const evt = event();
    const { sync, spies } = makeSync([evt]);
    await sync.syncCalendar("cal_1");
    evt.raw = { summary: "定例 #yui", status: "cancelled" };
    const [d] = await sync.syncCalendar("cal_1");
    expect(d).toMatchObject({ action: "unscheduled", reason: "cancelled" });
    expect(spies.unscheduleBot).toHaveBeenCalledTimes(1);
  });

  it("releases the ledger for a deleted event without calling Recall (it auto-unschedules)", async () => {
    const evt = event();
    const { sync, spies, calendarStore } = makeSync([evt]);
    await sync.syncCalendar("cal_1");
    evt.is_deleted = true;
    const [d] = await sync.syncCalendar("cal_1");
    expect(d).toMatchObject({ action: "unscheduled", reason: "deleted" });
    expect(spies.unscheduleBot).not.toHaveBeenCalled();
    expect(calendarStore.scheduled("evt_1")).toBeNull();
  });

  it("honours a manual opt-out over the marker, and a manual opt-in over a missing marker", async () => {
    const { sync, calendarStore, spies } = makeSync([event()]);
    calendarStore.setOverride("evt_1", "opt_out");
    expect((await sync.syncCalendar("cal_1"))[0]).toMatchObject({ action: "skipped", reason: "opted_out" });
    expect(spies.scheduleBot).not.toHaveBeenCalled();

    calendarStore.setOverride("evt_1", "opt_in");
    expect((await sync.syncCalendar("cal_1"))[0]).toMatchObject({ action: "scheduled", reason: "manual_opt_in" });
  });

  it("reports a failed unschedule instead of dropping the ledger", async () => {
    const evt = event();
    const { sync, calendarStore, spies } = makeSync([evt]);
    await sync.syncCalendar("cal_1");
    evt.raw = { summary: "定例" };
    (spies.unscheduleBot as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("recall 502 /bot/"));
    const [d] = await sync.syncCalendar("cal_1");
    expect(d!.action).toBe("failed");
    expect(calendarStore.scheduled("evt_1")).not.toBeNull();
  });
});

describe("calendar sync — arming the full bot config", () => {
  it("arms only events inside the window, once", async () => {
    const soon = event({ id: "soon", start_time: later(8) });
    const far = event({ id: "far", start_time: later(600) });
    const { sync, calendarStore, spies } = makeSync([soon, far]);
    // Schedule both directly: `soon` is inside the lead window for the rule, so seed the ledger.
    calendarStore.markScheduled({ eventId: "soon", calendarId: "cal_1", deduplicationKey: "k1", startsAt: soon.start_time, meetingUrl: soon.meeting_url!, botId: "bot_soon" });
    calendarStore.markScheduled({ eventId: "far", calendarId: "cal_1", deduplicationKey: "k2", startsAt: far.start_time, meetingUrl: far.meeting_url!, botId: "bot_far" });

    const armed = await sync.armDueEvents();
    expect(armed).toEqual([{ eventId: "soon", armed: true }]);
    expect(spies.scheduleBot).toHaveBeenCalledWith("soon", "k1", expect.objectContaining({ output_media: expect.anything() }));
    expect(calendarStore.scheduled("soon")!.armedAt).toBeTruthy();

    // A second pass is a no-op.
    (spies.scheduleBot as unknown as { mockClear: () => void }).mockClear();
    expect(await sync.armDueEvents()).toEqual([]);
    expect(spies.scheduleBot).not.toHaveBeenCalled();
  });

  it("reports BLOCKED_BY_RECALL_PUBLIC_URL instead of arming with no public URL", async () => {
    const soon = event({ id: "soon", start_time: later(8) });
    const { sync, calendarStore } = makeSync([soon], false);
    calendarStore.markScheduled({ eventId: "soon", calendarId: "cal_1", deduplicationKey: "k1", startsAt: soon.start_time, meetingUrl: soon.meeting_url!, botId: "b" });
    expect(await sync.armDueEvents()).toEqual([{ eventId: "soon", armed: false, error: "BLOCKED_BY_RECALL_PUBLIC_URL" }]);
    expect(calendarStore.scheduled("soon")!.armedAt).toBeUndefined();
  });
});

describe("calendar webhooks", () => {
  it("routes calendar.* to the calendar handler", () => {
    expect(isCalendarEvent("calendar.sync_events")).toBe(true);
    expect(isCalendarEvent("calendar.update")).toBe(true);
    expect(isCalendarEvent("bot.done")).toBe(false);
    expect(isCalendarEvent(undefined)).toBe(false);
  });

  it("calendar.sync_events re-syncs from last_updated_ts", async () => {
    const { sync, spies, calendarStore } = makeSync([event()]);
    await handleCalendarWebhook(
      { event: "calendar.sync_events", data: { calendar_id: "cal_1", last_updated_ts: "2026-09-01T04:00:00Z" } },
      sync,
      { client: spies as unknown as RecallCalendarClient, calendarStore },
    );
    expect(spies.listEvents).toHaveBeenCalledWith(expect.objectContaining({ calendarId: "cal_1", updatedAtGte: "2026-09-01T04:00:00Z" }));
    expect(spies.scheduleBot).toHaveBeenCalledTimes(1);
  });

  it("calendar.update with a disconnected calendar clears the ledger so nothing is armed later", async () => {
    const { sync, calendarStore } = makeSync([event()]);
    await sync.syncCalendar("cal_1");
    expect(calendarStore.scheduled("evt_1")).not.toBeNull();
    const disconnected = { retrieveCalendar: vi.fn(async () => ({ id: "cal_1", platform: "google_calendar", status: "disconnected" })) };
    await handleCalendarWebhook({ event: "calendar.update", data: { calendar_id: "cal_1" } }, sync, {
      client: disconnected as unknown as RecallCalendarClient,
      calendarStore,
    });
    expect(calendarStore.scheduled("evt_1")).toBeNull();
  });

  it("throws without a calendar_id so the queue retries", async () => {
    const { sync, calendarStore, spies } = makeSync([]);
    await expect(
      handleCalendarWebhook({ event: "calendar.sync_events", data: {} }, sync, { client: spies as unknown as RecallCalendarClient, calendarStore }),
    ).rejects.toThrow(/calendar_id/);
  });
});

describe("toSchedulable", () => {
  it("reads the title from Google summary and Microsoft subject", () => {
    expect(toSchedulable(event({ raw: { summary: "A #yui" } })).title).toBe("A #yui");
    expect(toSchedulable(event({ raw: { subject: "B #yui" } })).title).toBe("B #yui");
    expect(toSchedulable(event({ raw: {} })).title).toBe("");
  });

  it("maps Google's cancelled status and Recall's is_deleted", () => {
    expect(toSchedulable(event({ raw: { summary: "x", status: "cancelled" } })).isCancelled).toBe(true);
    expect(toSchedulable(event({ is_deleted: true })).isDeleted).toBe(true);
  });
});

describe("customer-owned OAuth callback", () => {
  const env = { RECALL_CALENDAR_REGIONAL_CALLBACK_URI: "https://ap-northeast-1.recall.ai/api/internal/calendar/cb" } as BrokerEnv;

  it("forwards a probe with no code or error", async () => {
    let seen: string | null = null;
    const fetchImpl = (async (url: string) => {
      seen = String(url);
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;
    const r = await forwardCalendarCallback(env, new URLSearchParams({ state: "s1", recall_calendar_setup_probe: "1" }), fetchImpl);
    expect(r.status).toBe(200);
    expect(seen).toContain("recall_calendar_setup_probe=1");
    expect(seen).toContain("state=s1");
  });

  it("forwards only the four allowed parameters", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = String(url);
      return new Response("", { status: 302 });
    }) as unknown as typeof fetch;
    await forwardCalendarCallback(env, new URLSearchParams({ state: "s", code: "c", scope: "calendar.events.readonly", authuser: "0", hd: "example.com" }), fetchImpl);
    const forwarded = new URL(seen).searchParams;
    expect([...forwarded.keys()].sort()).toEqual(["code", "state"]);
  });

  it("passes an error through", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = String(url);
      return new Response("denied", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await forwardCalendarCallback(env, new URLSearchParams({ state: "s", error: "access_denied" }), fetchImpl);
    expect(new URL(seen).searchParams.get("error")).toBe("access_denied");
    expect(r.status).toBe(200);
  });

  it("rejects a request with neither code, error nor probe", async () => {
    const fetchImpl = vi.fn();
    const r = await forwardCalendarCallback(env, new URLSearchParams({ state: "s" }), fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never logs parameter values, codes or the callback URL", async () => {
    const lines: Record<string, unknown>[] = [];
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    await forwardCalendarCallback(env, new URLSearchParams({ state: "signed.state.value", code: "4/secret-code" }), fetchImpl, (l) => lines.push(l));
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain("signed.state.value");
    expect(dump).not.toContain("4/secret-code");
    expect(dump).not.toContain("recall.ai/api/internal");
    expect(lines[0]).toMatchObject({ op: "calendar.callback", accepted: true, kind: "code" });
  });

  it("is blocked until the regional callback uri is configured", async () => {
    const r = await forwardCalendarCallback({} as BrokerEnv, new URLSearchParams({ state: "s", code: "c" }), (async () => new Response("")) as unknown as typeof fetch);
    expect(r.status).toBe(503);
    expect(r.body).toContain("BLOCKED_BY_RECALL_CALENDAR_CALLBACK");
  });

  it("reports 502 when the regional callback is unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await forwardCalendarCallback(env, new URLSearchParams({ state: "s", code: "c" }), fetchImpl);
    expect(r.status).toBe(502);
  });
});

describe("RecallCalendarClient", () => {
  it("targets /api/v2 in the workspace region and follows cursors verbatim", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(String(url));
      const body = urls.length === 1
        ? { results: [event()], next: "https://ap-northeast-1.recall.ai/api/v2/calendar-events/?cursor=abc" }
        : { results: [event({ id: "evt_2" })], next: null };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RecallCalendarClient({ apiKey: "k", region: "ap-northeast-1", fetchImpl });
    const events = await client.listEvents({ calendarId: "cal_1", updatedAtGte: "2026-09-01T00:00:00Z" });
    expect(events).toHaveLength(2);
    expect(urls[0]).toContain("https://ap-northeast-1.recall.ai/api/v2/calendar-events/?calendar_id=cal_1");
    expect(urls[0]).toContain("updated_at__gte=2026-09-01T00%3A00%3A00Z");
    expect(urls[1]).toBe("https://ap-northeast-1.recall.ai/api/v2/calendar-events/?cursor=abc");
  });

  it("retries a 409 from a parallel schedule and a 507 from the ad-hoc pool", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response("conflict", { status: 409 });
      if (n === 2) return new Response("no capacity", { status: 507 });
      return new Response(JSON.stringify({ id: "evt_1", bots: [{ bot_id: "bot_1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RecallCalendarClient({ apiKey: "k", region: "ap-northeast-1", fetchImpl, sleep: async () => {}, random: () => 0.5 });
    const res = await client.scheduleBot("evt_1", "key", { bot_name: "Yui" });
    expect(n).toBe(3);
    expect(res.bots?.[0]?.bot_id).toBe("bot_1");
  });

  it("sends the deduplication key and full bot_config", async () => {
    let body: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: "evt_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new RecallCalendarClient({ apiKey: "k", region: "ap-northeast-1", fetchImpl });
    await client.scheduleBot("evt_1", "2026-09-01-url", { bot_name: "Yui" });
    expect(body).toEqual({ deduplication_key: "2026-09-01-url", bot_config: { bot_name: "Yui" } });
  });
});
