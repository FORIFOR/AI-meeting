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
  const join = async (ws: WebSocketLike) => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const connector = new AttendeeConnector({
      brokerUrl: "http://broker",
      wsFactory: () => ws,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ botId: "att_1", clientWsUrl: "ws://broker/client", sampleRate: 24000 }));
      }) as unknown as typeof fetch,
    });
    const session = await connector.join({ meetingUrl: "https://meet.google.com/abc-defg-hij", displayName: "Yui", privacyMode: "default" });
    return { session, calls };
  };

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
