import { describe, expect, it } from "vitest";
import { MEETING_PERSONA_ID } from "./meetingPrompt.js";
import { defaultProactivityFor } from "./participationPolicy.js";

describe("default meeting proactivity", () => {
  it("keeps ordinary one-to-one conversation open", () => {
    expect(defaultProactivityFor({ mode: "free_talk" })).toBe("open");
  });

  it("does not join a multi-participant meeting uninvited by default", () => {
    expect(defaultProactivityFor({ mode: "meeting" })).toBe("invited");
    expect(defaultProactivityFor({ personaId: MEETING_PERSONA_ID })).toBe("invited");
  });
});
