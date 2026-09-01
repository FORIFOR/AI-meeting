import { describe, expect, it } from "vitest";
import { observation, shouldApplyStatus } from "./botState.js";

describe("bot state ordering", () => {
  it("moves forward", () => {
    expect(shouldApplyStatus("joining_call", "in_call_recording")).toBe(true);
    expect(shouldApplyStatus(null, "joining_call")).toBe(true);
  });

  it("refuses to go backwards when a delivery arrives late", () => {
    // Observed in a live call: in_call_recording was processed before in_call_not_recording.
    expect(shouldApplyStatus("in_call_recording", "in_call_not_recording")).toBe(false);
    expect(shouldApplyStatus("done", "call_ended")).toBe(false);
  });

  it("is idempotent for a repeated delivery", () => {
    expect(shouldApplyStatus("in_call_recording", "in_call_recording")).toBe(false);
  });

  it("lets fatal land from anywhere, once", () => {
    expect(shouldApplyStatus("in_call_recording", "fatal")).toBe(true);
    expect(shouldApplyStatus("fatal", "fatal")).toBe(false);
  });

  it("keeps the current state for a status Recall added after us", () => {
    expect(shouldApplyStatus("in_call_recording", "bot_did_a_new_thing")).toBe(false);
  });

  it("measures how long a transition took to reach us", () => {
    const o = observation({
      botId: "b", meetingId: "m", eventId: "msg_1", event: "bot.in_call_recording",
      status: "in_call_recording", subCode: null, receivedAt: 10_000, applied: true, reason: "applied",
      updatedAt: new Date(8_500).toISOString(),
    });
    expect(o.transitionLatencyMs).toBe(1500);
    expect(observation({ ...o, updatedAt: null }).transitionLatencyMs).toBeNull();
  });
});
