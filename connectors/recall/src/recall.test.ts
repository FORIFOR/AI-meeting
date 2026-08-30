import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { PrivacyViolationError } from "@rcai/provider-core";
import { RecallConnector, RecallSession, type WebSocketLike } from "./RecallConnector.js";
import { mapBotStatus, wordsToText, type CreateBotResponse } from "./protocol.js";
import { parseBotPageParams } from "./botPage.js";

class FakeWs implements WebSocketLike {
  static last: FakeWs | null = null;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
}

function pcm16b64(samples: number): string {
  const buf = new Int16Array(samples);
  for (let i = 0; i < samples; i++) buf[i] = Math.round(8000 * Math.sin(i / 5));
  return Buffer.from(buf.buffer).toString("base64");
}

const created: CreateBotResponse = { botId: "bot1", status: "joining_call", mode: "relay", clientWsUrl: "ws://localhost:8787/api/meeting/recall/client/bot1", region: "us-west-2" };

describe("RecallConnector", () => {
  it("refuses to join under strict_local", async () => {
    const c = new RecallConnector({ brokerUrl: "http://localhost:8787", fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch });
    await expect(c.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Yui", privacyMode: "strict_local" })).rejects.toBeInstanceOf(PrivacyViolationError);
  });
  it("surfaces BLOCKED_BY_RECALL_KEY from the broker", async () => {
    const c = new RecallConnector({ brokerUrl: "http://localhost:8787", fetchImpl: (async () => new Response(JSON.stringify({ error: "BLOCKED_BY_RECALL_KEY" }), { status: 503 })) as unknown as typeof fetch });
    await expect(c.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Yui", privacyMode: "default" })).rejects.toThrow("BLOCKED_BY_RECALL_KEY");
  });
  it("creates a bot through the broker and opens the relay socket", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      if (url.endsWith("/api/meeting/recall/bots")) return new Response(JSON.stringify(created));
      return new Response(JSON.stringify({ botId: "bot1", code: "in_call_recording", statusChanges: [] }));
    }) as unknown as typeof fetch;
    const c = new RecallConnector({ brokerUrl: "http://localhost:8787/", mode: "relay", fetchImpl, wsFactory: (u) => new FakeWs(u), pollIntervalMs: 100000 });
    const s = await c.join({ meetingUrl: "https://us02web.zoom.us/j/123", displayName: "Yui", privacyMode: "default", language: "ja" });
    expect(s.platform).toBe("zoom");
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ meetingUrl: "https://us02web.zoom.us/j/123", botName: "Yui", mode: "relay", language: "ja" });
    expect(FakeWs.last?.url).toBe(created.clientWsUrl);
    expect(c.capabilities().audioOut).toBe("none"); // no mp3 encoder supplied
    await s.leave();
    expect(calls.some((x) => x.url.endsWith("/bots/bot1/leave"))).toBe(true);
    expect(FakeWs.last?.closed).toBe(true);
  });
});

describe("RecallSession relay decoding", () => {
  const mk = (mode: "relay" | "output_media" = "relay") => new RecallSession({ ...created, mode }, "google_meet", { brokerUrl: "http://b", mode, clock: () => 1000 }, (async () => new Response("{}")) as unknown as typeof fetch);
  it("turns audio_mixed_raw.data (16k PCM16) into 48k internal frames", () => {
    const s = mk();
    const events: unknown[] = [];
    s.onEvent((e) => events.push(e));
    s.onRelayMessage(JSON.stringify({ relay: { botId: "bot1", receivedAt: 0 }, message: { event: "audio_mixed_raw.data", data: { data: { buffer: pcm16b64(3200), timestamp: { relative: 1 } } } } }));
    const audio = events.find((e) => (e as { type: string }).type === "audio") as { frame: { sampleRate: number; data: Float32Array } };
    expect(audio.frame.sampleRate).toBe(48000);
    expect(Math.abs(audio.frame.data.length - 9600)).toBeLessThanOrEqual(3);
  });
  it("maps transcripts with speaker names and participant/speech events", () => {
    const s = mk();
    const events: { type: string; [k: string]: unknown }[] = [];
    s.onEvent((e) => events.push(e as never));
    const p = { id: 7, name: "田中", is_host: true, platform: null, extra_data: null, email: null };
    s.onRelayMessage(JSON.stringify({ relay: { botId: "bot1", receivedAt: 0 }, message: { event: "transcript.partial_data", data: { data: { words: [{ text: "ゆい" }, { text: "さん" }], participant: p } } } }));
    s.onRelayMessage(JSON.stringify({ relay: { botId: "bot1", receivedAt: 0 }, message: { event: "transcript.data", data: { data: { words: [{ text: "ゆいさんは" }, { text: "どう思う？" }], participant: p } } } }));
    s.onRelayMessage(JSON.stringify({ relay: { botId: "bot1", receivedAt: 0 }, message: { event: "participant_events.join", data: { data: { participant: p } } } }));
    s.onRelayMessage(JSON.stringify({ relay: { botId: "bot1", receivedAt: 0 }, message: { event: "participant_events.speech_on", data: { data: { participant: p } } } }));
    expect(events.map((e) => e.type)).toEqual(["transcript", "transcript", "participant_joined", "speech"]);
    expect(events[0]).toMatchObject({ final: false, speakerName: "田中", text: "ゆいさん" });
    expect(events[1]).toMatchObject({ final: true, text: "ゆいさんはどう思う？", participantId: "7" });
    expect(events[3]).toMatchObject({ active: true });
  });
  it("status codes map to MeetingStatus and emit joined/left once", () => {
    const s = mk();
    const events: { type: string; status?: string }[] = [];
    s.onEvent((e) => events.push(e as never));
    s.applyStatus("joining_call");
    s.applyStatus("in_call_not_recording");
    s.applyStatus("in_call_recording");
    s.applyStatus("in_call_recording");
    s.applyStatus("call_ended", "timeout_exceeded_everyone_left");
    s.applyStatus("done");
    expect(events.filter((e) => e.type === "joined").length).toBe(1);
    expect(events.filter((e) => e.type === "left").length).toBe(1);
    expect(s.status()).toBe("ended"); // the meeting ended (Round 3 lifecycle distinguishes ended / removed / denied / left)
    expect(mapBotStatus("call_ended", "bot_received_leave_call")).toBe("left");
    expect(mapBotStatus("call_ended", "bot_kicked_from_call")).toBe("removed");
    expect(mapBotStatus("fatal")).toBe("failed");
    expect(mapBotStatus("in_waiting_room")).toBe("waiting_room");
  });
  it("relay mode buffers outbound audio and needs an mp3 encoder; output_media mode ignores it", async () => {
    const s = mk();
    s.applyStatus("in_call_recording"); // outbound audio is only accepted once admitted
    const errors: string[] = [];
    s.onEvent((e) => { if (e.type === "error") errors.push(e.error.message); });
    s.pushOutboundAudio(createFrame(new Float32Array(4800)));
    await s.endOutboundUtterance();
    expect(errors[0]).toMatch(/BLOCKED_BY_MP3_ENCODER/);
    const calls: string[] = [];
    const enc = new RecallSession({ ...created, mode: "relay" }, "google_meet", { brokerUrl: "http://b", mode: "relay", mp3Encoder: async () => new Uint8Array([1, 2, 3]) }, (async (u: string) => { calls.push(u); return new Response("{}"); }) as unknown as typeof fetch);
    enc.applyStatus("in_call_recording");
    enc.pushOutboundAudio(createFrame(new Float32Array(4800)));
    await enc.endOutboundUtterance();
    expect(calls[0]).toMatch(/\/bots\/bot1\/output_audio$/);
    const om = mk("output_media");
    om.pushOutboundAudio(createFrame(new Float32Array(4800)));
    await om.endOutboundUtterance(); // no-op, no error
  });
});

describe("helpers", () => {
  it("wordsToText joins JP tokens without spaces and EN with spaces", () => {
    expect(wordsToText([{ text: "今日" }, { text: "は" }, { text: "晴れ" }])).toBe("今日は晴れ");
    expect(wordsToText([{ text: "what" }, { text: "do" }, { text: "you" }, { text: "think" }])).toBe("what do you think");
  });
  it("parses bot page params", () => {
    expect(parseBotPageParams("?foo=1")).toBeNull();
    expect(parseBotPageParams("?rcai_bot=1&botId=b1&character=yui&persona=friend_ja&engine=openai&name=Yui")).toMatchObject({ token: "", botId: "b1", characterId: "yui", personaId: "friend_ja", engine: "openai", displayName: "Yui" });
    // Signed form (Round 3): the token payload (unverified peek) carries sid/bot/brk; nothing else is in the URL.
    const payload = Buffer.from(JSON.stringify({ sid: "s1", bot: "b9", role: "bot_page", exp: 1, iat: 0, nonce: "n", brk: "https://broker.example" })).toString("base64url");
    expect(parseBotPageParams(`?rcai_bot=1&token=${payload}.sig`)).toMatchObject({ token: `${payload}.sig`, botId: "b9", brokerUrl: "https://broker.example" });
  });
});
