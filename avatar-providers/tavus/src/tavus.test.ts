// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import type { CharacterDefinition } from "@rcai/avatar-core";
import { TavusAvatarProvider, type DailyCallLike } from "./TavusAvatarProvider.js";

const character: CharacterDefinition = {
  manifest: { id: "mika", name: "Mika", renderer: "tavus", defaultPersona: "free_talk", supportedLanguages: ["ja-JP"], motionProfile: "none", voiceProfiles: [] },
  baseUrl: "/characters/mika", model: "r_replica_1", expressions: {}, motions: {}, voice: { characterId: "mika", voices: {} },
};

class FakeCall implements DailyCallLike {
  joined: { url: string } | null = null;
  destroyed = false;
  handlers = new Map<string, (ev: unknown) => void>();
  messages: { msg: unknown; to?: string }[] = [];
  localAudio: boolean | null = null;
  async join(o: { url: string }) { this.joined = o; }
  async leave() { this.joined = null; }
  async destroy() { this.destroyed = true; }
  on(e: string, cb: (ev: unknown) => void) { this.handlers.set(e, cb); }
  sendAppMessage(msg: unknown, to?: string) { this.messages.push({ msg, to }); }
  setLocalAudio(v: boolean) { this.localAudio = v; }
  setLocalVideo() {}
}
const fetchStub = (h: (url: string, init?: RequestInit) => Response) => (async (u: string | URL | Request, i?: RequestInit) => h(String(u), i)) as unknown as typeof fetch;

describe("TavusAvatarProvider", () => {
  it("prepare() hits the broker and surfaces BLOCKED_BY_TAVUS_KEY", async () => {
    const blocked = new TavusAvatarProvider({ brokerUrl: "http://broker", container: document.createElement("div"), fetch: fetchStub(() => new Response(JSON.stringify({ error: "BLOCKED_BY_TAVUS_KEY" }), { status: 503 })) });
    await expect(blocked.prepare(character)).rejects.toThrow("BLOCKED_BY_TAVUS_KEY");
    let body: Record<string, unknown> = {};
    const p = new TavusAvatarProvider({ brokerUrl: "http://broker", container: document.createElement("div"), personaId: "p1", fetch: fetchStub((_u, init) => { body = JSON.parse(String(init?.body)); return new Response(JSON.stringify({ conversation_id: "c123", conversation_url: "https://x.daily.co/c123", status: "active" })); }) });
    await p.prepare(character);
    expect(body).toEqual({ personaId: "p1", replicaId: "r_replica_1", conversationName: "Mika" });
    expect(p.currentConversation).toEqual({ conversationId: "c123", conversationUrl: "https://x.daily.co/c123" });
  });

  it("joins Daily, echoes audio with the documented shape, interrupts, maps events, stops", async () => {
    const call = new FakeCall();
    const container = document.createElement("div");
    const p = new TavusAvatarProvider({ brokerUrl: "http://broker", container, chunkMs: 20, fetch: fetchStub(() => new Response(JSON.stringify({ conversationId: "c123", conversationUrl: "https://x.daily.co/c123" }))), callFactory: async () => call });
    await p.prepare(character);
    await p.start();
    expect(call.joined).toEqual({ url: "https://x.daily.co/c123" });
    expect(call.localAudio).toBe(false);
    expect(container.querySelector("video")).not.toBeNull();

    p.setState("SPEAKING");
    p.pushAudio(createFrame(new Float32Array(1920).fill(0.1))); // 40 ms → 2 × 20 ms @ 24 kHz
    const echoes = call.messages.filter((m) => (m.msg as { event_type: string }).event_type === "conversation.echo");
    expect(echoes.length).toBe(2);
    expect(echoes[0]!.to).toBe("*");
    const first = echoes[0]!.msg as { message_type: string; conversation_id: string; properties: Record<string, unknown> };
    expect(first.message_type).toBe("conversation");
    expect(first.conversation_id).toBe("c123");
    expect(first.properties.modality).toBe("audio");
    expect(first.properties.sample_rate).toBe(24000);
    expect(first.properties.done).toBe(false);
    expect(typeof first.properties.inference_id).toBe("string");
    expect(atob(first.properties.audio as string).length).toBe(960);

    p.setState("IDLE");
    const last = call.messages[call.messages.length - 1]!.msg as { properties: { done: boolean } };
    expect(last.properties.done).toBe(true);

    p.speakText("こんにちは");
    expect((call.messages[call.messages.length - 1]!.msg as { properties: unknown }).properties).toEqual({ modality: "text", text: "こんにちは" });

    p.interrupt();
    expect(call.messages[call.messages.length - 1]!.msg).toEqual({ message_type: "conversation", event_type: "conversation.interrupt", conversation_id: "c123" });

    const events: string[] = [];
    p.onEvent((e) => events.push(e.type));
    call.handlers.get("app-message")!({ data: { message_type: "conversation", event_type: "conversation.started_speaking", conversation_id: "c123", properties: { role: "pal" } } });
    call.handlers.get("app-message")!({ data: { message_type: "conversation", event_type: "conversation.stopped_speaking", conversation_id: "c123", properties: { role: "user" } } });
    call.handlers.get("app-message")!({ data: { message_type: "conversation", event_type: "conversation.utterance", conversation_id: "c123", properties: { role: "user", speech: "hi" } } });
    expect(events).toEqual(["avatar_speech_started", "user_speech_ended", "utterance"]);

    await p.stop();
    expect(call.destroyed).toBe(true);
    expect(container.querySelector("video")).toBeNull();
  });
});
