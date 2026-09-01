import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { canonicalJson, handleAttendeeWebhook, resetAttendeeAnnouncements, verifyAttendeeSignature } from "./attendeeWebhooks.js";

const store = (status: string) => {
  const rec = { id: "mtg_1", botId: "att_1", status, lifecycle: [] as { event: string }[] };
  return {
    rec,
    list: () => [rec],
    update: (_id: string, patch: Record<string, unknown>, event?: string) => {
      Object.assign(rec, patch);
      if (event) rec.lifecycle.push({ event });
      return rec;
    },
  };
};

describe("Attendee webhook signature", () => {
  it("rebuilds the canonical JSON Attendee signs, not the bytes it sent", () => {
    // sort_keys=True, separators=(",", ":"), ensure_ascii=False
    expect(canonicalJson({ b: 1, a: { d: "ゆい", c: [1, 2] } })).toBe('{"a":{"c":[1,2],"d":"ゆい"},"b":1}');
  });

  it("accepts a correct signature and refuses a wrong one", () => {
    const payload = { trigger: "bot.state_change", bot_id: "att_1", data: { new_state: "joined_recording" } };
    const sig = createHmac("sha256", "sekrit").update(canonicalJson(payload), "utf8").digest("base64");
    expect(verifyAttendeeSignature(payload, sig, "sekrit")).toBe(true);
    expect(verifyAttendeeSignature(payload, sig, "other")).toBe(false);
    expect(verifyAttendeeSignature(payload, undefined, "sekrit")).toBe(false);
  });
});

describe("Attendee bot state", () => {
  it("moves the meeting forward and tells participants once", () => {
    resetAttendeeAnnouncements();
    const s = store("joining_call");
    const joined = vi.fn();
    handleAttendeeWebhook({ trigger: "bot.state_change", bot_id: "att_1", data: { new_state: "joined_recording" } }, { store: s as never, onJoined: joined });
    expect(s.rec.status).toBe("in_call_recording");
    expect(joined).toHaveBeenCalledTimes(1);
    // A second delivery of the same state must not announce again.
    handleAttendeeWebhook({ trigger: "bot.state_change", bot_id: "att_1", data: { new_state: "joined_recording" } }, { store: s as never, onJoined: joined });
    expect(joined).toHaveBeenCalledTimes(1);
  });

  it("refuses to go backwards when a delivery arrives late", () => {
    const s = store("in_call_recording");
    handleAttendeeWebhook({ trigger: "bot.state_change", bot_id: "att_1", data: { new_state: "waiting_room" } }, { store: s as never });
    expect(s.rec.status).toBe("in_call_recording");
    expect(s.rec.lifecycle.at(-1)!.event).toBe("attendee.waiting_room:skipped");
  });

  it("carries a fatal state and its reason", () => {
    const s = store("in_waiting_room");
    handleAttendeeWebhook({ trigger: "bot.state_change", bot_id: "att_1", data: { new_state: "fatal_error", event_sub_type: "meeting_not_found" } }, { store: s as never });
    expect(s.rec.status).toBe("fatal");
    expect((s.rec as { statusSubCode?: string }).statusSubCode).toBe("meeting_not_found");
  });

  it("ignores triggers it does not handle without throwing", () => {
    const s = store("joining_call");
    expect(handleAttendeeWebhook({ trigger: "transcript.update", bot_id: "att_1" }, { store: s as never }).applied).toBe(false);
    expect(handleAttendeeWebhook({}, { store: s as never }).ok).toBe(true);
  });
});
