import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPT_IN_RULE,
  decideEvent,
  deduplicationKey,
  normalizeTitle,
  type OptInRule,
  type SchedulableEvent,
} from "./scheduling.js";

const NOW = Date.parse("2026-09-01T09:00:00+09:00");
const rule: OptInRule = DEFAULT_OPT_IN_RULE;

function ev(patch: Partial<SchedulableEvent> = {}): SchedulableEvent {
  return {
    id: "evt_1",
    title: "定例 #yui",
    startsAt: new Date(NOW + 60 * 60_000).toISOString(),
    endsAt: new Date(NOW + 90 * 60_000).toISOString(),
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    ...patch,
  };
}

const decide = (e: SchedulableEvent, override?: "opt_in" | "opt_out" | null) =>
  decideEvent({ event: e, rule, override, now: NOW });

describe("opt-in rule — eligible", () => {
  it("schedules a future event whose title carries the marker", () => {
    const d = decide(ev());
    expect(d).toMatchObject({ eligible: true, reason: "marker_matched", matchedMarker: "#yui" });
  });

  it("matches the second configured marker", () => {
    expect(decide(ev({ title: "Weekly #rehearsal" })).eligible).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(decide(ev({ title: "Sprint #YUI review" })).eligible).toBe(true);
  });

  it("matches a full-width marker typed on a Japanese IME", () => {
    expect(decide(ev({ title: "面接練習　＃ＹＵＩ" })).eligible).toBe(true);
  });

  it("matches a marker anywhere in the title", () => {
    expect(decide(ev({ title: "#yui" })).eligible).toBe(true);
    expect(decide(ev({ title: "1on1 with Haru #yui (JP)" })).eligible).toBe(true);
  });

  it("accepts a Zoom meeting url", () => {
    expect(decide(ev({ meetingUrl: "https://us02web.zoom.us/j/123456789" })).eligible).toBe(true);
  });

  it("manual opt-in overrides a missing marker", () => {
    const d = decide(ev({ title: "Board sync" }), "opt_in");
    expect(d).toMatchObject({ eligible: true, reason: "manual_opt_in" });
  });
});

describe("opt-in rule — skipped", () => {
  it("skips an untagged event (the default is never to record)", () => {
    expect(decide(ev({ title: "顧客定例" }))).toMatchObject({ eligible: false, reason: "no_marker" });
  });

  it("skips a past event", () => {
    const past = ev({ startsAt: new Date(NOW - 60_000).toISOString() });
    expect(decide(past)).toMatchObject({ eligible: false, reason: "already_started" });
  });

  it("skips an event that starts inside the lead window", () => {
    const soon = ev({ startsAt: new Date(NOW + 5 * 60_000).toISOString() });
    expect(decide(soon)).toMatchObject({ eligible: false, reason: "starts_too_soon" });
  });

  it("accepts an event exactly at the lead boundary", () => {
    const boundary = ev({ startsAt: new Date(NOW + 10 * 60_000).toISOString() });
    expect(decide(boundary).eligible).toBe(true);
  });

  it("skips a deleted event even when it is tagged", () => {
    expect(decide(ev({ isDeleted: true }))).toMatchObject({ eligible: false, reason: "deleted" });
  });

  it("skips a cancelled event even when it is tagged", () => {
    expect(decide(ev({ isCancelled: true }))).toMatchObject({ eligible: false, reason: "cancelled" });
  });

  it("skips an event with no meeting url", () => {
    expect(decide(ev({ meetingUrl: null }))).toMatchObject({ eligible: false, reason: "no_meeting_url" });
    expect(decide(ev({ meetingUrl: "   " }))).toMatchObject({ eligible: false, reason: "no_meeting_url" });
  });

  it("skips an unsupported meeting link", () => {
    expect(decide(ev({ meetingUrl: "https://example.com/room/42" }))).toMatchObject({
      eligible: false,
      reason: "unsupported_platform",
    });
  });

  it("skips an event with an unparseable start time", () => {
    expect(decide(ev({ startsAt: "next tuesday" }))).toMatchObject({ eligible: false, reason: "invalid_start_time" });
  });

  it("manual opt-out beats the marker", () => {
    expect(decide(ev(), "opt_out")).toMatchObject({ eligible: false, reason: "opted_out" });
  });

  it("manual opt-in cannot resurrect a deleted or past event", () => {
    expect(decide(ev({ isDeleted: true }), "opt_in").eligible).toBe(false);
    expect(decide(ev({ startsAt: new Date(NOW - 1).toISOString() }), "opt_in").eligible).toBe(false);
  });

  it("does not treat a bare word as a marker", () => {
    expect(decide(ev({ title: "yui と打ち合わせ" }))).toMatchObject({ eligible: false, reason: "no_marker" });
  });

  it("ignores an empty marker in the configuration", () => {
    const d = decideEvent({ event: ev({ title: "何もなし" }), rule: { ...rule, markers: ["", "  "] }, now: NOW });
    expect(d).toMatchObject({ eligible: false, reason: "no_marker" });
  });

  it("handles a missing title without throwing", () => {
    const d = decideEvent({ event: { ...ev(), title: undefined as unknown as string }, rule, now: NOW });
    expect(d.eligible).toBe(false);
  });
});

describe("timezone and DST safety", () => {
  it("compares absolute instants across offsets", () => {
    // 10:30 JST written as a UTC instant — one hour after `now`, so it is eligible.
    const utc = ev({ startsAt: "2026-09-01T01:00:00Z" });
    expect(decide(utc).eligible).toBe(true);
    // Same wall clock, different offset: 10:00 in UTC is 19:00 JST, still in the future.
    expect(decide(ev({ startsAt: "2026-09-01T10:00:00Z" })).eligible).toBe(true);
  });

  it("treats a US DST-transition timestamp by its offset, not its wall clock", () => {
    // 2026-11-01 America/Los_Angeles falls back; both offsets resolve to distinct instants.
    const before = decideEvent({ event: ev({ startsAt: "2026-11-01T01:30:00-07:00" }), rule, now: Date.parse("2026-11-01T00:00:00-07:00") });
    const after = decideEvent({ event: ev({ startsAt: "2026-11-01T01:30:00-08:00" }), rule, now: Date.parse("2026-11-01T00:00:00-07:00") });
    expect(before.eligible).toBe(true);
    expect(after.eligible).toBe(true);
  });
});

describe("deduplicationKey", () => {
  it("is the recommended start-time + meeting-url pair", () => {
    const e = ev();
    expect(deduplicationKey(e)).toBe(`${e.startsAt}-${e.meetingUrl}`);
  });

  it("changes when the event is moved, so a rescheduled event gets a fresh bot", () => {
    const a = deduplicationKey(ev());
    const b = deduplicationKey(ev({ startsAt: new Date(NOW + 120 * 60_000).toISOString() }));
    expect(a).not.toBe(b);
  });

  it("is shared by two calendars holding the same meeting", () => {
    const mine = ev({ id: "evt_a" });
    const theirs = ev({ id: "evt_b" });
    expect(deduplicationKey(mine)).toBe(deduplicationKey(theirs));
  });
});

describe("normalizeTitle", () => {
  it("folds width, case and non-breaking spaces", () => {
    expect(normalizeTitle("面接　＃ＹＵＩ")).toContain("#yui");
    expect(normalizeTitle("A #Yui")).toBe("a #yui");
  });
});
