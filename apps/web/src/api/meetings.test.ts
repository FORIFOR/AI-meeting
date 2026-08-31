import { describe, expect, it } from "vitest";
import {
  blocksToText,
  clockLabel,
  failureSentence,
  groupUtterances,
  isFinished,
  reasonJa,
  sortMeetings,
  splitEvents,
  statusJa,
  type CalendarEvent,
  type MeetingRecord,
} from "./meetings.js";

const ev = (id: string, startsAt: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: `event ${id}`,
  startsAt,
  eligible: false,
  reason: "no_marker",
  ...extra,
});

describe("reasonJa", () => {
  it("explains why the character joins or not, using the configured marker", () => {
    expect(reasonJa("no_marker", { markers: ["#rehearsal"], leadMinutes: 2 })).toBe("タイトルに #rehearsal がありません");
    expect(reasonJa("marker")).toBe("タイトルに #yui があります");
    expect(reasonJa("past")).toBe("過去の予定です");
    expect(reasonJa("no_meeting_link")).toBe("会議リンクがありません");
    expect(reasonJa("opted_out")).toBe("参加しない設定です");
    expect(reasonJa("opted_in")).toBe("参加する設定にしました");
  });
  it("never leaks an unknown backend code into the sentence", () => {
    const s = reasonJa("weird_new_backend_code");
    expect(s).toBe("この予定は対象外です");
    expect(s).not.toContain("weird_new_backend_code");
  });
});

describe("statusJa / failureSentence", () => {
  it("maps lifecycle states, including raw bot.* event names", () => {
    expect(statusJa("in_call")).toBe("会議中");
    expect(statusJa("bot.in_call_recording")).toBe("会議中");
    expect(statusJa("waiting_room")).toBe("待機室で承認待ち");
    expect(statusJa("something_new")).toBe("状態を確認中");
  });
  it("turns failures into one sentence and leaves successes alone", () => {
    expect(failureSentence({ status: "bot.fatal", hasTranscript: false })).toBe("この会議には参加できませんでした。");
    expect(failureSentence({ status: "denied", hasTranscript: false })).toContain("承認しなかった");
    expect(failureSentence({ status: "transcript_failed", hasTranscript: false })).toBe("文字起こしを作成できませんでした。");
    expect(failureSentence({ status: "done", hasTranscript: true })).toBeNull();
  });
  it("knows which meetings are finished", () => {
    expect(isFinished({ status: "in_call" })).toBe(false);
    expect(isFinished({ status: "bot.done" })).toBe(true);
    expect(isFinished({ status: "removed" })).toBe(true);
  });
});

describe("splitEvents", () => {
  it("puts upcoming events first ascending and past events descending", () => {
    const now = Date.parse("2026-09-01T12:00:00Z");
    const events = [
      ev("later", "2026-09-01T15:00:00Z"),
      ev("soon", "2026-09-01T13:00:00Z"),
      ev("yesterday", "2026-08-31T09:00:00Z", { endsAt: "2026-08-31T10:00:00Z" }),
      ev("earlier-today", "2026-09-01T09:00:00Z", { endsAt: "2026-09-01T10:00:00Z" }),
    ];
    const { upcoming, past } = splitEvents(events, now);
    expect(upcoming.map((e) => e.id)).toEqual(["soon", "later"]);
    expect(past.map((e) => e.id)).toEqual(["earlier-today", "yesterday"]);
  });
  it("treats an event that is still running as upcoming", () => {
    const now = Date.parse("2026-09-01T12:30:00Z");
    const running = ev("running", "2026-09-01T12:00:00Z", { endsAt: "2026-09-01T13:00:00Z" });
    expect(splitEvents([running], now).upcoming.map((e) => e.id)).toEqual(["running"]);
  });
});

describe("sortMeetings", () => {
  it("lists the most recently updated meeting first", () => {
    const rec = (id: string, updatedAt: string): MeetingRecord => ({
      id,
      meetingUrl: "https://meet.google.com/x",
      status: "done",
      source: "calendar",
      hasTranscript: true,
      createdAt: "2026-08-01T00:00:00Z",
      updatedAt,
    });
    const out = sortMeetings([rec("a", "2026-08-30T10:00:00Z"), rec("b", "2026-08-31T10:00:00Z"), rec("c", "2026-08-29T10:00:00Z")]);
    expect(out.map((m) => m.id)).toEqual(["b", "a", "c"]);
  });
});

describe("groupUtterances", () => {
  it("merges consecutive utterances from one speaker into readable dialogue", () => {
    const blocks = groupUtterances({
      utterances: [
        { speaker: "堀尾", text: "おはようございます", startMs: 1000 },
        { speaker: "堀尾", text: "今日はよろしくお願いします。", startMs: 2500 },
        { speaker: "Yui", text: "こちらこそ！", startMs: 5000 },
        { speaker: "堀尾", text: "では始めましょう", startMs: 8000 },
      ],
    });
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ speaker: "堀尾", startMs: 1000 });
    expect(blocks[0]!.text).toBe("おはようございます 今日はよろしくお願いします。");
    expect(blocks[1]!.speaker).toBe("Yui");
    expect(blocksToText(blocks).split("\n")).toHaveLength(3);
  });
  it("accepts the word-level shape, skips empties and names unknown speakers", () => {
    const blocks = groupUtterances({ words: [{ text: " " }, { text: "はい" }, { speaker: "", text: "そうですね" }] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.speaker).toBe("話者不明");
    expect(blocks[0]!.text).toBe("はい そうですね");
  });
  it("returns nothing for a missing transcript", () => {
    expect(groupUtterances(null)).toEqual([]);
    expect(groupUtterances({})).toEqual([]);
  });
});

describe("clockLabel", () => {
  it("formats elapsed time and ignores missing values", () => {
    expect(clockLabel(0)).toBe("00:00");
    expect(clockLabel(65_000)).toBe("01:05");
    expect(clockLabel(undefined)).toBe("");
  });
});
