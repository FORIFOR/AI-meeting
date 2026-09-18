import { describe, expect, it } from "vitest";
import { ExecutionLedger } from "./execution.js";

describe("verified execution lifecycle", () => {
  it("cannot claim success before external verification", () => {
    const x = new ExecutionLedger<{ title: string }>();
    const draft = x.create({ id: "x1", idempotencyKey: "calendar:abc", action: "calendar.create", payload: { title: "打ち合わせ" }, now: 1 });
    expect(draft.state).toBe("draft");
    expect(x.canClaimSuccess("x1")).toBe(false);
    x.transition("x1", "approved", { now: 2 });
    x.transition("x1", "executing", { now: 3 });
    x.transition("x1", "unknown", { error: "connection lost after submit", now: 4 });
    expect(x.canClaimSuccess("x1")).toBe(false);
    x.transition("x1", "verified", { result: { externalId: "evt_1" }, now: 5 });
    expect(x.canClaimSuccess("x1")).toBe(true);
  });

  it("rejects duplicate idempotency keys and skipped approval", () => {
    const x = new ExecutionLedger();
    x.create({ id: "x1", idempotencyKey: "mail:1", action: "mail.send", payload: {}, now: 1 });
    expect(() => x.create({ id: "x2", idempotencyKey: "mail:1", action: "mail.send", payload: {}, now: 2 })).toThrow("duplicate idempotency key");
    expect(() => x.transition("x1", "executing")).toThrow(/invalid execution transition/);
  });
});
