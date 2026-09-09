import { estimateMeetingCredits } from "./costs.js";
export interface MeetingUsageReceipt { elapsedMs: number; credits: number | null; endedAt: number; }
const terminal = new Set(["left", "ended", "removed", "denied", "failed"]);
/** A browser observation, not a vendor invoice. One created bot per attempt; duplicate terminal events do not extend it. */
export class MeetingUsageTracker {
  private startedAt: number | null = null;
  private receipt: MeetingUsageReceipt | null = null;
  created(at: number) { if (this.startedAt === null && !this.receipt) this.startedAt = at; }
  status(status: string, at: number): MeetingUsageReceipt | null {
    return terminal.has(status) ? this.finish(at) : null;
  }
  finish(at: number): MeetingUsageReceipt | null {
    if (this.receipt) return this.receipt;
    if (this.startedAt === null) return null;
    const elapsedMs = Math.max(0, at - this.startedAt);
    // A missing duration is unknown, never a promise of free usage.
    this.receipt = { elapsedMs, credits: elapsedMs > 0 ? estimateMeetingCredits(elapsedMs / 60000, 1) : null, endedAt: at };
    return this.receipt;
  }
}
