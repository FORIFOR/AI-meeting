import { privacyGuard } from "@rcai/provider-core";
import type { PrivacyMode } from "@rcai/conversation-core";
import type { SessionReport, TelemetryEnvelope } from "./types.js";

const CONTENT_KEY = /text|transcript|caption|prompt|content|quote|note|utterance|audio|video|image/i;

/** Deep copy that drops any key that could carry user content and any string longer than 64 chars. */
export function stripContent<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripContent(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEY.test(k)) continue;
      if (typeof v === "string" && v.length > 64) continue;
      out[k] = stripContent(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Telemetry-safe view of a report. Reports carry no content by construction; this is the
 * belt-and-braces layer (also applies provider-core's `privacyGuard.sanitizeTelemetry`).
 */
export function sanitizeForTelemetry(report: SessionReport, privacyMode: PrivacyMode): Partial<SessionReport> {
  const stripped = stripContent(report) as unknown as Record<string, unknown>;
  return privacyGuard.sanitizeTelemetry(privacyMode, stripped) as Partial<SessionReport>;
}

export interface TelemetrySenderOptions {
  brokerUrl: string;
  privacyMode: PrivacyMode;
  fetch?: typeof fetch;
  now?: () => number;
  /** Bound best-effort delivery so an unavailable broker cannot hold session completion open. */
  timeoutMs?: number;
}

export type TelemetryOutcome = "sent" | "skipped-strict" | "failed";

/**
 * Sends a sanitized report to the broker. Under strict_local this is a no-op that never
 * touches the network (spec §6: telemetry本文送信禁止 — we send nothing at all).
 */
export function createTelemetrySender(opts: TelemetrySenderOptions): { send(report: SessionReport): Promise<TelemetryOutcome> } {
  const fetchImpl = opts.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  return {
    async send(report) {
      if (opts.privacyMode === "strict_local") return "skipped-strict";
      if (!fetchImpl) return "failed";
      const envelope: TelemetryEnvelope = { schema: "rcai.telemetry.v1", sentAt: (opts.now ?? Date.now)(), privacyMode: opts.privacyMode, report: sanitizeForTelemetry(report, opts.privacyMode) };
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<"failed">((resolve) => {
          timeout = setTimeout(() => {
            resolve("failed");
            controller.abort();
          }, opts.timeoutMs ?? 2500);
        });
        const delivery = fetchImpl(`${opts.brokerUrl.replace(/\/$/, "")}/api/telemetry`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: controller.signal })
          .then((res): TelemetryOutcome => res.ok ? "sent" : "failed");
        return await Promise.race([delivery, expired]);
      } catch {
        return "failed";
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
