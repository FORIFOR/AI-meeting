import { describe, expect, it } from "vitest";
import { MeetingLifecycle, lifecycleToStatus, mapRecallStatus } from "./lifecycle.js";

function drive(events: Parameters<MeetingLifecycle["dispatch"]>[0][], lc = new MeetingLifecycle(0)): MeetingLifecycle {
  let t = 0;
  for (const e of events) lc.dispatch(e, (t += 100));
  return lc;
}
const recall = (code: string, sub?: string | null) => {
  const m = mapRecallStatus(code, sub);
  if (!m) throw new Error(`no mapping for ${code}/${sub}`);
  return { type: "vendor_status" as const, state: m.state, detail: m.detail };
};

describe("MeetingLifecycle transitions", () => {
  it("happy path: created → joining → waiting_room → admitted → ended", () => {
    const lc = drive([recall("joining_call"), recall("in_waiting_room"), recall("in_call_recording"), recall("call_ended", "call_ended_by_host")]);
    expect(lc.getHistory().map((t) => t.to)).toEqual(["joining", "waiting_room", "admitted", "ended"]);
    expect(lc.isTerminal).toBe(true);
    expect(lifecycleToStatus(lc.state)).toBe("ended");
  });
  it("waiting room denied by host", () => {
    const lc = drive([recall("joining_call"), recall("in_waiting_room"), recall("call_ended", "bot_kicked_from_waiting_room")]);
    expect(lc.state).toBe("denied");
  });
  it("waiting room timeout → denied", () => {
    expect(drive([recall("in_waiting_room"), recall("call_ended", "timeout_exceeded_waiting_room")]).state).toBe("denied");
  });
  it("knocking disabled (fatal) → denied", () => {
    expect(drive([recall("joining_call"), recall("fatal", "google_meet_knocking_disabled")]).state).toBe("denied");
  });
  it("admitted then host kicks the bot → removed", () => {
    expect(drive([recall("joining_call"), recall("in_call_not_recording"), recall("call_ended", "bot_kicked_from_call")]).state).toBe("removed");
  });
  it("meeting ended (everyone left / platform idle / fatal meeting_ended)", () => {
    expect(drive([recall("in_call_recording"), recall("call_ended", "timeout_exceeded_everyone_left")]).state).toBe("ended");
    expect(drive([recall("in_call_recording"), recall("call_ended", "call_ended_by_platform_idle")]).state).toBe("ended");
    expect(drive([recall("joining_call"), recall("fatal", "meeting_ended")]).state).toBe("ended");
  });
  it("our own leave → left, and later vendor codes cannot revive it", () => {
    const lc = drive([recall("in_call_recording"), { type: "leave" }]);
    expect(lc.state).toBe("left");
    expect(lc.dispatch(recall("call_ended", "bot_received_leave_call"), 999)).toBeNull();
    expect(lc.dispatch(recall("in_call_recording"), 1000)).toBeNull();
    expect(lc.state).toBe("left");
  });
  it("fatal errors → failed", () => {
    expect(drive([recall("joining_call"), recall("fatal", "meeting_not_found")]).state).toBe("failed");
    expect(drive([recall("joining_call"), recall("fatal", "bot_errored")]).state).toBe("failed");
  });
  it("done / breakout codes are informational", () => {
    expect(mapRecallStatus("done")).toBeNull();
    expect(mapRecallStatus("breakout_room_entered")).toBeNull();
  });
  it("stale polls never regress admitted to joining", () => {
    const lc = drive([recall("joining_call"), recall("in_call_recording"), recall("joining_call")]);
    expect(lc.state).toBe("admitted");
  });
});

describe("MeetingLifecycle host mute", () => {
  it("pauses outbound while muted and reports mute changes", () => {
    const lc = drive([recall("in_call_recording")]);
    const seen: boolean[] = [];
    lc.onMute((m) => seen.push(m));
    expect(lc.outboundAllowed).toBe(true);
    lc.dispatch({ type: "host_mute", muted: true }, 500);
    expect(lc.outboundAllowed).toBe(false);
    expect(lc.audioMuted).toBe(true);
    lc.dispatch({ type: "host_mute", muted: true }, 600); // idempotent
    lc.dispatch({ type: "host_mute", muted: false }, 700);
    expect(lc.outboundAllowed).toBe(true);
    expect(seen).toEqual([true, false]);
  });
  it("outbound is not allowed in the waiting room or while reconnecting", () => {
    const lc = drive([recall("in_waiting_room")]);
    expect(lc.outboundAllowed).toBe(false);
    lc.dispatch(recall("in_call_recording"), 200);
    lc.dispatch({ type: "relay_down" }, 300);
    expect(lc.state).toBe("reconnecting");
    expect(lc.outboundAllowed).toBe(false);
  });
});

describe("MeetingLifecycle reconnect", () => {
  it("relay drop → reconnecting with exponential backoff → admitted on relay_up", () => {
    const lc = drive([recall("in_call_recording")]);
    lc.dispatch({ type: "relay_down" }, 1000);
    expect(lc.nextReconnectDelayMs(1000)).toBe(1000);
    expect(lc.nextReconnectDelayMs(2000)).toBe(2000);
    expect(lc.nextReconnectDelayMs(4000)).toBe(4000);
    expect(lc.nextReconnectDelayMs(8000)).toBe(8000);
    expect(lc.nextReconnectDelayMs(16000)).toBe(8000); // capped
    lc.dispatch({ type: "relay_up" }, 17000);
    expect(lc.state).toBe("admitted");
    expect(lc.snapshot().reconnectAttempt).toBe(5);
  });
  it("gives up after the reconnect timeout → failed", () => {
    const lc = drive([recall("in_call_recording")]);
    lc.dispatch({ type: "relay_down" }, 1000);
    expect(lc.dispatch({ type: "tick" }, 30_000)).toBeNull();
    expect(lc.nextReconnectDelayMs(61_000)).toBeNull();
    expect(lc.dispatch({ type: "tick" }, 61_000)?.to).toBe("failed");
    expect(lc.snapshot().reason).toBe("reconnect_timeout");
  });
  it("a vendor admitted status while reconnecting restores admitted", () => {
    const lc = drive([recall("in_call_recording")]);
    lc.dispatch({ type: "relay_down" }, 1000);
    lc.dispatch(recall("in_call_recording"), 1500);
    expect(lc.state).toBe("admitted");
  });
  it("relay_down before admission is ignored", () => {
    const lc = drive([recall("in_waiting_room")]);
    expect(lc.dispatch({ type: "relay_down" }, 500)).toBeNull();
    expect(lc.state).toBe("waiting_room");
  });
});

describe("MeetingLifecycle output media", () => {
  it("first failure allows one retry, second failure fails the session", () => {
    const lc = drive([recall("in_call_recording")]);
    expect(lc.dispatch({ type: "output_media_failed", detail: "no activation" }, 1000)).toBeNull();
    expect(lc.state).toBe("admitted");
    expect(lc.snapshot().outputMediaRetries).toBe(1);
    const t = lc.dispatch({ type: "output_media_failed", detail: "no activation" }, 2000);
    expect(t?.to).toBe("failed");
    expect(t?.reason).toContain("output_media_failed");
  });
  it("output media failure before admission is ignored", () => {
    const lc = drive([recall("joining_call")]);
    expect(lc.dispatch({ type: "output_media_failed" }, 100)).toBeNull();
  });
});
