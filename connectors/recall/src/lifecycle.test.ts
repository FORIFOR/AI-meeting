import { describe, expect, it, vi } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { RecallSession, type WebSocketLike } from "./RecallConnector.js";
import type { CreateBotResponse } from "./protocol.js";
import statusFixtures from "../fixtures/status-webhooks.json" with { type: "json" };
import pollFixtures from "../fixtures/bot-status-poll.json" with { type: "json" };

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  drop() { this.onclose?.({}); }
}

const created = (mode: "relay" | "output_media" = "relay", status = "joining_call"): CreateBotResponse => ({ botId: "bot_fixture", sessionId: "sid1", status, mode, clientWsUrl: "ws://localhost:8787/api/meeting/recall/client/bot_fixture?token=t", clientToken: "t", region: "us-west-2" });

function harness(opts: { mode?: "relay" | "output_media"; status?: string; fetch?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  FakeWs.all = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return opts.fetch ? await opts.fetch(url, init) : new Response(JSON.stringify(pollFixtures.in_call), { status: 200 });
  }) as unknown as typeof fetch;
  const session = new RecallSession(created(opts.mode, opts.status), "google_meet", { brokerUrl: "http://localhost:8787", mode: opts.mode ?? "relay", wsFactory: (u) => new FakeWs(u), pollIntervalMs: 100_000, clock: () => Date.now(), lifecycle: { reconnectBaseMs: 100, reconnectMaxDelayMs: 400, reconnectTimeoutMs: 3000 }, outputMediaActivationTimeoutMs: 2000, mp3Encoder: async () => new Uint8Array([1, 2, 3]) }, fetchImpl);
  const events: string[] = [];
  session.onEvent((e) => events.push(e.type === "status" ? `status:${e.status}` : e.type === "audio_muted" ? `muted:${e.muted}` : e.type === "left" ? `left:${e.reason}` : e.type));
  return { session, events, calls };
}
const webhookCode = (k: keyof typeof statusFixtures) => (statusFixtures[k] as { data: { data: { code: string; sub_code: string | null } } }).data.data;
const apply = (s: RecallSession, k: keyof typeof statusFixtures) => { const c = webhookCode(k); s.applyStatus(c.code, c.sub_code); };

describe("RecallSession lifecycle (fixtures)", () => {
  it("waiting room → admitted → host kicks → removed, cleanup, later frames ignored", () => {
    const { session, events } = harness();
    session.start();
    apply(session, "joining"); apply(session, "waiting_room");
    expect(session.status()).toBe("waiting_room");
    expect(session.outboundAllowed).toBe(false);
    apply(session, "admitted_not_recording");
    expect(session.status()).toBe("in_call");
    expect(events).toContain("joined");
    apply(session, "removed_by_host");
    expect(session.status()).toBe("removed");
    expect(events.at(-1)).toBe("left:vendor_status:call_ended/bot_kicked_from_call");
    expect(FakeWs.all[0]!.closed).toBe(true);
    apply(session, "done"); // informational
    apply(session, "admitted_recording"); // stale — must not revive
    expect(session.status()).toBe("removed");
    vi.useRealTimers();
  });
  it("denied in the waiting room (host) and by timeout; knocking disabled (fatal)", () => {
    for (const k of ["denied_waiting_room", "denied_timeout", "fatal_knocking_disabled"] as const) {
      const { session } = harness();
      session.start();
      apply(session, "joining"); apply(session, "waiting_room"); apply(session, k);
      expect(session.status()).toBe("denied");
      vi.useRealTimers();
    }
  });
  it("meeting ended (host / everyone left) and fatal errors", () => {
    const a = harness(); a.session.start(); apply(a.session, "admitted_recording"); apply(a.session, "meeting_ended_by_host");
    expect(a.session.status()).toBe("ended");
    const b = harness(); b.session.start(); apply(b.session, "admitted_recording"); apply(b.session, "everyone_left");
    expect(b.session.status()).toBe("ended");
    const c = harness(); c.session.start(); apply(c.session, "joining"); apply(c.session, "fatal_not_found");
    expect(c.session.status()).toBe("failed");
    vi.useRealTimers();
  });
  it("host mute pauses outbound audio (relay clips are dropped while muted) and emits audio_muted", async () => {
    const { session, events, calls } = harness();
    session.start();
    apply(session, "admitted_recording");
    session.pushOutboundAudio(createFrame(new Float32Array(480)));
    session.setAudioMuted(true);
    expect(events).toContain("muted:true");
    expect(session.outboundAllowed).toBe(false);
    session.pushOutboundAudio(createFrame(new Float32Array(480))); // dropped
    await session.endOutboundUtterance(); // muted → nothing sent
    expect(calls.some((c) => c.url.endsWith("/output_audio"))).toBe(false);
    session.setAudioMuted(false);
    session.pushOutboundAudio(createFrame(new Float32Array(480)));
    await session.endOutboundUtterance();
    expect(calls.some((c) => c.url.endsWith("/output_audio"))).toBe(true);
    // best-effort mute from participant update payload for self
    session.onRelayMessage(JSON.stringify({ relay: { botId: "bot_fixture" }, message: { event: "participant_events.update", data: { data: { participant: { id: 1, name: "Yui", is_self: true }, muted: true } } } }));
    expect(session.outboundAllowed).toBe(false);
    vi.useRealTimers();
  });
  it("frames for another bot are ignored (bot binding)", () => {
    const { session, events } = harness();
    session.start();
    session.onRelayMessage(JSON.stringify({ relay: { botId: "someone_else" }, message: { event: "transcript.data", data: { data: { words: [{ text: "hi" }] } } } }));
    expect(events.filter((e) => e === "transcript").length).toBe(0);
    session.onRelayMessage(JSON.stringify({ relay: { botId: "bot_fixture" }, message: { event: "transcript.data", data: { data: { words: [{ text: "hi" }] } } } }));
    expect(events.filter((e) => e === "transcript").length).toBe(1);
    vi.useRealTimers();
  });
});

describe("RecallSession network reconnect", () => {
  it("relay drop after admission → reconnecting with backoff → admitted on reopen; policy consumers see status events", () => {
    const { session, events } = harness();
    session.start();
    apply(session, "admitted_recording");
    const ws1 = FakeWs.all[0]!;
    ws1.open();
    ws1.drop();
    expect(session.status()).toBe("reconnecting");
    expect(session.outboundAllowed).toBe(false);
    expect(FakeWs.all.length).toBe(1);
    vi.advanceTimersByTime(100); // first backoff
    expect(FakeWs.all.length).toBe(2);
    FakeWs.all[1]!.drop(); // still down
    vi.advanceTimersByTime(1500 + 200);
    expect(FakeWs.all.length).toBe(3);
    FakeWs.all[2]!.open();
    expect(session.status()).toBe("in_call");
    expect(events.filter((e) => e === "status:reconnecting").length).toBe(1);
    expect(events.at(-1)).toBe("status:in_call");
    expect(session.snapshot().reconnectAttempt).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
  it("gives up after the reconnect timeout → failed + cleanup", () => {
    const { session, events } = harness();
    session.start();
    apply(session, "admitted_recording");
    FakeWs.all[0]!.open();
    FakeWs.all[0]!.drop();
    for (let i = 0; i < 40; i++) {
      vi.advanceTimersByTime(250);
      const last = FakeWs.all.at(-1)!;
      if (!last.closed && last.onclose && session.status() === "reconnecting") last.drop();
    }
    expect(session.status()).toBe("failed");
    expect(events.some((e) => e.startsWith("left:reconnect_timeout"))).toBe(true);
    vi.useRealTimers();
  });
  it("relay drop before admission just retries quietly", () => {
    const { session } = harness();
    session.start();
    apply(session, "waiting_room");
    FakeWs.all[0]!.drop();
    expect(session.status()).toBe("waiting_room");
    vi.advanceTimersByTime(2000);
    expect(FakeWs.all.length).toBe(2);
    vi.useRealTimers();
  });
});

describe("RecallSession output media watchdog", () => {
  it("restarts output media once when the bot page never activates, then fails", async () => {
    const restarts: string[] = [];
    const { session, events } = harness({ mode: "output_media", fetch: (url, init) => {
      if (url.endsWith("/output_media/restart")) { restarts.push(init?.method ?? ""); return new Response(JSON.stringify({ ok: true, restarts: restarts.length })); }
      return new Response(JSON.stringify({ ...pollFixtures.in_call, botPageActivatedAt: null }));
    } });
    session.start();
    apply(session, "admitted_recording");
    await vi.advanceTimersByTimeAsync(2100);
    expect(restarts).toEqual(["POST"]);
    expect(session.status()).toBe("in_call");
    await vi.advanceTimersByTimeAsync(2100);
    expect(session.status()).toBe("failed");
    expect(events.some((e) => e.startsWith("left:output_media_failed"))).toBe(true);
    vi.useRealTimers();
  });
  it("activation reported by the broker disarms the watchdog", async () => {
    const { session } = harness({ mode: "output_media", fetch: () => new Response(JSON.stringify({ ...pollFixtures.in_call, botPageActivatedAt: 1_000_500 })) });
    session.start();
    await vi.runOnlyPendingTimersAsync();
    apply(session, "admitted_recording");
    vi.advanceTimersByTime(5000);
    expect(session.status()).toBe("in_call");
    vi.useRealTimers();
  });
  it("leave → left, cleanup, and later vendor codes are ignored; duplicate leave is a no-op", async () => {
    const { session, events, calls } = harness();
    session.start();
    apply(session, "admitted_recording");
    await session.leave();
    expect(session.status()).toBe("left");
    expect(calls.some((c) => c.url.endsWith("/leave") && c.init?.method === "POST")).toBe(true);
    const n = calls.length;
    await session.leave();
    expect(calls.length).toBe(n);
    apply(session, "left_on_request");
    expect(session.status()).toBe("left");
    expect(events.filter((e) => e.startsWith("left:")).length).toBe(1);
    vi.useRealTimers();
  });
});
