import { describe, expect, it, vi } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { SessionObserver, reportToMarkdown } from "./observer.js";
import { createTelemetrySender, sanitizeForTelemetry, stripContent } from "./telemetry.js";
import { histogram, summarize } from "./stats.js";

function run() {
  let t = 0;
  const o = new SessionObserver({ sessionId: "s1", clock: () => t, provider: "local" });
  o.handleEvent({ type: "session_ready", providerId: "local" });
  // turn 1: 600 ms response
  o.handleEvent({ type: "user_speech_started", at: 1000 });
  o.handleEvent({ type: "user_speech_ended", at: 2000 });
  o.handleEvent({ type: "user_transcript", text: "こんにちは", final: true });
  o.handleEvent({ type: "assistant_speech_started", at: 2600 });
  o.handleEvent({ type: "assistant_transcript", text: "やあ", final: true });
  o.handleEvent({ type: "metrics", turn: { sttMs: 120, llmTtftMs: 150, ttsTtfaMs: 50, firstAudioSentMs: 520, engines: { stt: "sense_voice", llm: "gemma" } } });
  o.handleEvent({ type: "assistant_speech_ended", at: 4000 });
  // turn 2: 1200 ms response, interrupted by the user
  o.handleEvent({ type: "user_speech_started", at: 5000 });
  o.handleEvent({ type: "user_speech_ended", at: 6000 });
  o.handleEvent({ type: "user_transcript", text: "質問です", final: true });
  o.handleEvent({ type: "assistant_speech_started", at: 7200 });
  o.handleEvent({ type: "assistant_audio", frame: createFrame(new Float32Array(10)) });
  o.handleEvent({ type: "user_speech_started", at: 7700 });
  o.handleEvent({ type: "interrupted", at: 7700 });
  // reconnect + error
  o.handleEvent({ type: "error", error: new Error("ws closed BLOCKED_BY_NETWORK こんにちは"), fatal: false });
  o.handleEvent({ type: "session_ready", providerId: "local" });
  o.noteStaleDrops(3);
  o.noteLatencySample("interrupt_stop", 43);
  o.noteLatencySample("listening_react", 0);
  o.noteFrameInterval(16);
  o.noteFrameInterval(17);
  o.noteLipDelay(40);
  o.setMeetingState("recall", "in_call", "bot1");
  t = 60000;
  o.end();
  return o;
}

describe("SessionObserver", () => {
  it("aggregates counts, latencies, reconnects, interruptions, breakdown, errors", () => {
    const r = run().toReport();
    expect(r.provider).toBe("local");
    expect(r.turns).toEqual({ user: 2, assistant: 2, interruptedAssistant: 1 });
    expect(r.responseLatency.count).toBe(2);
    expect(r.responseLatency.p50).toBe(600);
    expect(r.responseLatency.p95).toBe(1200);
    expect(r.responseLatency.histogram.find((b) => b.from === 500)!.count).toBe(1);
    expect(r.responseLatency.histogram.find((b) => b.from === 1000)!.count).toBe(1);
    expect(r.reconnects).toBe(1);
    expect(r.interruptions.byUser).toBe(1);
    expect(r.staleDrops).toBe(3);
    expect(r.stt.p50).toBe(120);
    expect(r.llmTtft.p50).toBe(150);
    expect(r.ttsTtfa.p50).toBe(50);
    expect(r.firstAudio.p50).toBe(520);
    expect(r.engines).toEqual({ stt: "sense_voice", llm: "gemma" });
    expect(r.avatar.lipDelayMs.p50).toBe(40);
    expect(r.avatar.frameIntervalMs.count).toBe(2);
    expect(r.meeting).toEqual({ connector: "recall", state: "in_call", botId: "bot1" });
    expect(r.errors).toEqual({ count: 1, fatal: 0, codes: ["BLOCKED_BY_NETWORK"] });
    expect(r.durationMs).toBe(60000);
    expect(JSON.stringify(r)).not.toContain("こんにちは");
    const md = reportToMarkdown(r);
    expect(md).toContain("| response (user end → assistant start) | 600 | 1200 |");
    expect(md).toContain("stale drops: 3");
  });
});

describe("telemetry privacy", () => {
  it("strips content-like keys and long strings", () => {
    const out = stripContent({ turns: 3, transcript: "secret", nested: { text: "x", ok: 1, note: "n" }, long: "a".repeat(80), code: "BLOCKED_BY_X" }) as Record<string, unknown>;
    expect(out).toEqual({ turns: 3, nested: { ok: 1 }, code: "BLOCKED_BY_X" });
  });
  it("sanitized report carries no text and strict_local never sends", async () => {
    const r = run().toReport();
    const s = sanitizeForTelemetry(r, "default");
    expect(JSON.stringify(s)).not.toMatch(/こんにちは|transcript/);
    expect(s.turns?.user).toBe(2);
    let calls = 0;
    const sender = createTelemetrySender({ brokerUrl: "http://localhost:8787", privacyMode: "strict_local", fetch: (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch });
    expect(await sender.send(r)).toBe("skipped-strict");
    expect(calls).toBe(0);
    let body = "";
    const sender2 = createTelemetrySender({ brokerUrl: "http://localhost:8787/", privacyMode: "default", fetch: (async (_u: string, init?: RequestInit) => { body = String(init?.body); return new Response("{}"); }) as unknown as typeof fetch });
    expect(await sender2.send(r)).toBe("sent");
    const env = JSON.parse(body);
    expect(env.schema).toBe("rcai.telemetry.v1");
    expect(env.report.sessionId).toBe("s1");
    expect(JSON.stringify(env)).not.toMatch(/text|transcript|こんにちは/);
  });

  it("bounds stalled delivery and aborts the request even if fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | null | undefined;
      const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      });
      const sender = createTelemetrySender({ brokerUrl: "https://broker.test", privacyMode: "default", fetch: fetchImpl as typeof fetch });
      const result = sender.send(run().toReport());
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toBe("failed");
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its delivery deadline after a successful response", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => new Response("{}"));
      const sender = createTelemetrySender({ brokerUrl: "https://broker.test", privacyMode: "default", fetch: fetchImpl });
      expect(await sender.send(run().toReport())).toBe("sent");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stats", () => {
  it("summarize + histogram", () => {
    expect(summarize([300, 100, 200]).p50).toBe(200);
    expect(summarize([]).count).toBe(0);
    const h = histogram([50, 350, 4000]);
    expect(h[0]!.count).toBe(1);
    expect(h[1]!.count).toBe(1);
    expect(h[h.length - 1]!.count).toBe(1);
    expect(h[h.length - 1]!.to).toBeNull();
  });
});
