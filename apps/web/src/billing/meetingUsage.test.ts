import { expect, it } from "vitest";
import { MeetingUsageTracker } from "./meetingUsage.js";
it("does not call a failed creation free usage", () => {
  expect(new MeetingUsageTracker().status("failed",100)).toBeNull();
});
it.each(["ended","left","removed","denied","failed"])("finishes once on %s and includes waiting/reconnect time", status => {
  const tracker=new MeetingUsageTracker();tracker.created(1000);
  expect(tracker.status("waiting_room",2000)).toBeNull();
  expect(tracker.status("reconnecting",5000)).toBeNull();
  tracker.created(10000);
  const receipt=tracker.status(status,61000);
  expect(receipt).toEqual({elapsedMs:60000,credits:.02,endedAt:61000});
  expect(tracker.finish(120000)).toBe(receipt);
});
it("does not invent a zero charge for an unmeasurable interval",()=>{
  const tracker=new MeetingUsageTracker();tracker.created(1000);
  expect(tracker.finish(1000)?.credits).toBeNull();
});
