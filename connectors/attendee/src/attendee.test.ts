import { describe, expect, it, vi } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { AttendeeConnector, type WebSocketLike } from "./AttendeeConnector.js";
import { decodeChunk, encodeChunk } from "./protocol.js";

function fakeWs() {
  const sent: string[] = [];
  const ws: WebSocketLike & { sent: string[] } = {
    sent,
    send: (d: string) => sent.push(d),
    close: () => {},
    onmessage: null,
    onopen: null,
    onclose: null,
  };
  return ws;
}

describe("Attendee audio codec", () => {
  it("round-trips 16-bit PCM through base64", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
    expect(Array.from(decodeChunk(encodeChunk(pcm)))).toEqual(Array.from(pcm));
  });
});

describe("AttendeeConnector", () => {
  const join = async (ws: WebSocketLike, extra: { clock?: () => number; botPageQuery?: Record<string, string> } = {}) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = new AttendeeConnector({
      brokerUrl: "http://broker",
      wsFactory: () => ws,
      ...extra,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ botId: "att_1", clientWsUrl: "ws://broker/client", sampleRate: 24000 }));
      }) as unknown as typeof fetch,
    });
    const session = await connector.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Yui", privacyMode: "default" });
    return { session, calls };
  };

  it("forwards the selected character, purpose and voice to the hosted bot", async () => {
    const chosen = { character: "haru", persona: "english_beginner", voice: "Aoede", engine: "google", outbound: "page" };
    const { calls } = await join(fakeWs(), { botPageQuery: chosen });
    expect(JSON.parse(String(calls[0]!.init?.body)).botPageQuery).toEqual(chosen);
  });

  it("says what it can do: audio out is a stream, not clips", () => {
    const c = new AttendeeConnector({ brokerUrl: "http://broker" });
    expect(c.capabilities().audioOut).toBe("pcm_stream");
    expect(c.capabilities().videoOut).toBe(true);
  });

  it("turns meeting audio into frames and the character's voice into bot_output", async () => {
    const ws = fakeWs();
    const { session } = await join(ws);
    const frames: number[] = [];
    session.onEvent((e) => { if (e.type === "audio") frames.push(e.frame.data.length); });
    ws.onopen?.();
    ws.onmessage?.({ data: JSON.stringify({ relay: { botId: "att_1" }, message: { trigger: "realtime_audio.mixed", data: { chunk: encodeChunk(Int16Array.from([100, 200, 300])), sample_rate: 24000 } } }) });
    expect(frames).toEqual([3]);

    session.pushOutboundAudio(createFrame(new Float32Array(480).fill(0.25), 48000, 0));
    const out = JSON.parse(ws.sent.at(-1)!);
    expect(out.trigger).toBe("realtime_audio.bot_output");
    expect(out.data.sample_rate).toBe(24000);
    expect(decodeChunk(out.data.chunk).length).toBeGreaterThan(0);
  });

  it("hears each voice once: the mix is the ears, a participant's own stream only says who is talking", async () => {
    vi.useFakeTimers();
    try {
      const ws = fakeWs();
      const { session } = await join(ws);
      const audio: number[] = [];
      const speech: { id: string; active: boolean }[] = [];
      session.onEvent((e) => {
        if (e.type === "audio") audio.push(e.frame.data.length);
        if (e.type === "speech") speech.push({ id: e.participant.id, active: e.active });
      });
      ws.onopen?.();
      // Attendee sends the same 10 ms of speech twice: once in the mix, once on the speaker's socket.
      const voiced = encodeChunk(Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 6000 : -6000)));
      const silent = encodeChunk(new Int16Array(160));
      const send = (trigger: string, chunk: string, participant_uuid?: string) =>
        ws.onmessage?.({ data: JSON.stringify({ relay: { botId: "att_1" }, message: { trigger, data: { chunk, sample_rate: 16000, ...(participant_uuid ? { participant_uuid } : {}) } } }) });
      send("realtime_audio.mixed", voiced);
      send("realtime_audio.per_participant", voiced, "p-1");
      send("realtime_audio.mixed", voiced);
      send("realtime_audio.per_participant", voiced, "p-1");
      expect(audio).toEqual([160, 160]);
      expect(speech).toEqual([{ id: "p-1", active: true }]);

      // Quiet chunks on a participant's socket are not a turn, and the floor is released after the hangover.
      send("realtime_audio.per_participant", silent, "p-2");
      vi.advanceTimersByTime(600);
      expect(speech).toEqual([{ id: "p-1", active: true }, { id: "p-1", active: false }]);
      expect(audio).toEqual([160, 160]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports how loud each participant's own stream is, at most ten times a second", async () => {
    let t = 1000;
    const ws = fakeWs();
    const { session } = await join(ws, { clock: () => t });
    const levels: { id: string; level: number; at: number }[] = [];
    session.onEvent((e) => { if (e.type === "speech_level") levels.push({ id: e.participantId, level: e.level, at: e.at }); });
    ws.onopen?.();
    const loud = encodeChunk(Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 6000 : -6000)));
    const faint = encodeChunk(Int16Array.from({ length: 160 }, (_, i) => (i % 2 ? 200 : -200)));
    const silent = encodeChunk(new Int16Array(160));
    const send = (chunk: string, participant_uuid: string) =>
      ws.onmessage?.({ data: JSON.stringify({ relay: { botId: "att_1" }, message: { trigger: "realtime_audio.per_participant", data: { chunk, sample_rate: 16000, participant_uuid } } }) });
    send(loud, "p-1"); t += 10;
    send(loud, "p-1"); t += 10; // inside the 100 ms: not reported again
    send(faint, "p-2"); t += 80;
    send(silent, "p-1"); // below the floor: nothing to report
    send(loud, "p-1");
    expect(levels.map((l) => l.id)).toEqual(["p-1", "p-2", "p-1"]);
    expect(levels[0]!.level).toBeCloseTo(20 * Math.log10(6000 / 0x8000), 1);
    expect(levels[1]!.level).toBeLessThan(levels[0]!.level - 25);
    expect(levels[2]!.at - levels[0]!.at).toBe(100);
  });

  it("ignores another bot's feed", async () => {
    const ws = fakeWs();
    const { session } = await join(ws);
    let heard = 0;
    session.onEvent((e) => { if (e.type === "audio") heard++; });
    ws.onmessage?.({ data: JSON.stringify({ relay: { botId: "someone_else" }, message: { trigger: "realtime_audio.mixed", data: { chunk: encodeChunk(Int16Array.from([1])) } } }) });
    expect(heard).toBe(0);
  });

  it("surfaces a broker refusal instead of returning a dead session", async () => {
    const connector = new AttendeeConnector({
      brokerUrl: "http://broker",
      fetchImpl: (async () => new Response(JSON.stringify({ error: "BLOCKED_BY_ATTENDEE_KEY" }), { status: 503 })) as unknown as typeof fetch,
    });
    await expect(connector.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Yui", privacyMode: "default" })).rejects.toThrow(/BLOCKED_BY_ATTENDEE_KEY/);
  });
});
