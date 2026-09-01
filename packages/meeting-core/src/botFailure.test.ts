import { describe, expect, it } from "vitest";
import { describeBotFailure, isPermanentBotFailure } from "./botFailure.js";

describe("bot failure sub codes", () => {
  it("names the meeting settings the operator has to change", () => {
    const f = describeBotFailure("google_meet_knocking_disabled");
    expect(f.category).toBe("meeting_settings");
    expect(f.action).toContain("カレンダー招待");
    expect(f.retryable).toBe(false);
  });

  it("tells the operator to add logins when the group runs dry", () => {
    const f = describeBotFailure("google_meet_login_not_available");
    expect(f.category).toBe("credentials");
    expect(f.retryable).toBe(true);
  });

  it("still says something usable for a sub code Recall added after us", () => {
    // Recall explicitly reserves the right to add values, so this must never be a blank screen.
    const f = describeBotFailure("google_meet_something_new");
    expect(f.category).toBe("unknown");
    expect(f.message).toContain("google_meet_something_new");
    expect(f.action).not.toBe("");
  });

  it("handles a missing sub code", () => {
    expect(describeBotFailure(null).message).toBeTruthy();
    expect(describeBotFailure(undefined).subCode).toBe("");
  });

  it("separates permanent failures from ones worth retrying", () => {
    expect(isPermanentBotFailure("google_meet_organisation_restricted")).toBe(true);
    expect(isPermanentBotFailure("timeout_exceeded_waiting_room")).toBe(false);
  });
});
