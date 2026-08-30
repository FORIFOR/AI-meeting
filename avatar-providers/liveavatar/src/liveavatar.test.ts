// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import type { CharacterDefinition } from "@rcai/avatar-core";
import { LiveAvatarProvider, type RoomLike, type SocketLike } from "./LiveAvatarProvider.js";

const character: CharacterDefinition = {
  manifest: { id: "rin", name: "Rin", renderer: "liveavatar", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "none", voiceProfiles: [] },
  baseUrl: "/characters/rin", model: "avatar_uuid_123", expressions: {}, motions: {}, voice: { characterId: "rin", voices: {} },
};

class FakeSocket implements SocketLike {
  readyState = 1;
  messages: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  send(d: string) { this.messages.push(d); }
  close() { this.readyState = 3; }
}
class FakeRoom implements RoomLike {
  connected: [string, string] | null = null;
  handlers = new Map<string, (...a: unknown[]) => void>();
  async connect(url: string, token: string) { this.connected = [url, token]; }
  async disconnect() { this.connected = null; }
  on(e: string, cb: (...a: unknown[]) => void) { this.handlers.set(e, cb); }
}

function fetchStub(handler: (url: string, init?: RequestInit) => Response) {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as unknown as typeof fetch;
}

describe("LiveAvatarProvider", () => {
  it("prepare() maps the broker/HeyGen session fields and 503 → BLOCKED_BY_HEYGEN_KEY", async () => {
    const blocked = new LiveAvatarProvider({ brokerUrl: "http://broker", container: document.createElement("div"), fetch: fetchStub(() => new Response(JSON.stringify({ error: "BLOCKED_BY_HEYGEN_KEY" }), { status: 503 })) });
    await expect(blocked.prepare(character)).rejects.toThrow("BLOCKED_BY_HEYGEN_KEY");

    let posted: { url: string; body: unknown } | null = null;
    const p = new LiveAvatarProvider({
      brokerUrl: "http://broker/",
      container: document.createElement("div"),
      fetch: fetchStub((url, init) => {
        posted = { url, body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify({ code: 100, data: { session_id: "s1", livekit_url: "wss://lk", livekit_client_token: "tok", ws_url: "wss://cmd" } }));
      }),
    });
    await p.prepare(character);
    expect(posted!.url).toBe("http://broker/api/avatar/heygen/session");
    expect((posted!.body as { avatarId: string }).avatarId).toBe("avatar_uuid_123");
    expect(p.currentSession).toEqual({ sessionId: "s1", livekitUrl: "wss://lk", livekitClientToken: "tok", wsUrl: "wss://cmd" });
  });

  it("start() joins LiveKit, streams 24k PCM16 as agent.speak, interrupts and stops", async () => {
    const socket = new FakeSocket();
    const room = new FakeRoom();
    const calls: string[] = [];
    const container = document.createElement("div");
    const p = new LiveAvatarProvider({
      brokerUrl: "http://broker",
      container,
      chunkMs: 20,
      fetch: fetchStub((url) => { calls.push(url); return new Response(JSON.stringify({ sessionId: "s1", url: "wss://lk", accessToken: "tok", wsUrl: "wss://cmd" })); }),
      roomFactory: async () => room,
      socketFactory: () => socket,
    });
    await p.prepare(character);
    await p.start();
    expect(room.connected).toEqual(["wss://lk", "tok"]);
    expect(container.querySelector("video")).not.toBeNull();

    // 40 ms of 48 kHz audio → two 20 ms chunks at 24 kHz (480 samples = 960 bytes each).
    p.setState("SPEAKING");
    p.pushAudio(createFrame(new Float32Array(1920).fill(0.25)));
    const speak = socket.messages.map((m) => JSON.parse(m)).filter((m) => m.type === "agent.speak");
    expect(speak.length).toBe(2);
    expect(atob(speak[0].audio).length).toBe(960);

    const events: string[] = [];
    p.onEvent((e) => events.push(e.type));
    socket.onmessage?.({ data: JSON.stringify({ type: "agent.speak_started" }) });
    expect(events).toEqual(["avatar_speech_started"]);

    p.setState("IDLE");
    expect(socket.messages.map((m) => JSON.parse(m).type)).toContain("agent.speak_end");
    p.setState("LISTENING");
    expect(socket.messages.map((m) => JSON.parse(m).type)).toContain("agent.start_listening");
    p.interrupt();
    expect(JSON.parse(socket.messages[socket.messages.length - 1]!)).toEqual({ type: "agent.interrupt" });

    await p.stop();
    expect(room.connected).toBeNull();
    expect(socket.readyState).toBe(3);
    expect(calls[calls.length - 1]).toBe("http://broker/api/avatar/heygen/stop");
    expect(container.querySelector("video")).toBeNull();
  });
});
