import { describe, expect, it } from "vitest";
import { pillFor } from "./pill.js";

describe("pillFor", () => {
  it("maps every avatar state to a pill and never shows a score", () => {
    expect(pillFor("LISTENING").en).toBe("Listening");
    expect(pillFor("THINKING").key).toBe("thinking");
    expect(pillFor("SPEAKING").key).toBe("speaking");
    expect(pillFor("INTERRUPTED").key).toBe("interrupted");
    expect(pillFor("REACTING").key).toBe("idle");
    expect(pillFor("IDLE", true).en).toBe("Connecting");
    for (const s of ["IDLE", "LISTENING", "THINKING", "SPEAKING", "INTERRUPTED", "REACTING"] as const) {
      expect(JSON.stringify(pillFor(s))).not.toMatch(/score|点/);
    }
  });
});
