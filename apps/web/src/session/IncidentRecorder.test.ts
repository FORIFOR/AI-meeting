import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { IncidentRecorder, int16ToWavBase64, saveIncidentMeta, submitIncident } from "./IncidentRecorder.js";
import type { AvatarProvider, AvatarState } from "@rcai/avatar-core";

class FakeAvatar implements AvatarProvider {
  id = "fake";
  calls: string[] = [];
  async prepare() {}
  async start() {}
  pushAudio() {}
  setState(s: AvatarState) { this.calls.push(`state:${s}`); }
  setEmotion(e: string, i: number) { this.calls.push(`emotion:${e}:${i}`); }
  performGesture(g: string) { this.calls.push(`gesture:${g}`); }
  setGaze(t: { kind: string; x?: number; y?: number }) { this.calls.push(`gaze:${t.kind}`); }
  interrupt() { this.calls.push("interrupt"); }
  async stop() {}
  getParams() { return { mouthOpenY: 0 } as never; }
}

function loud(n = 960) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = 0.3 * Math.sin(i / 5);
  return d;
}

describe("IncidentRecorder", () => {
  it("captures a ±5 s window of events/states/motion/emotion/gaze/vad and never audio without opt-in", () => {
    let t = 0;
    const rec = new IncidentRecorder({ sessionId: () => "s1", clock: () => t, getProvider: () => "local", getAvatarState: () => "SPEAKING", getHud: () => ({ turn: 1 }) });
    const av = new FakeAvatar();
    const wrapped = rec.wrapAvatar(av);
    t = 1000; rec.recordEvent({ type: "user_speech_started" });
    t = 3500; rec.recordState({ from: "IDLE", to: "LISTENING", event: "userSpeechStarted", at: 3500 });
    t = 3000; wrapped.setEmotion("smile" as never, 0.5); wrapped.setGaze({ kind: "away", x: 0.3 });
    t = 4000; rec.recordMicFrame(createFrame(loud(), 48000, 4000));
    t = 4500; rec.recordEvent({ type: "assistant_transcript", text: "x".repeat(500), final: false });
    t = 20000; rec.recordEvent({ type: "assistant_speech_started" }); // outside window later
    t = 8000;
    const inc = rec.capture("不自然だった瞬間", "笑顔が変");
    expect(av.calls).toEqual(["emotion:smile:0.5", "gaze:away"]); // delegation intact
    const kinds = inc.entries.map((e) => `${e.kind}@${e.rel}`);
    expect(kinds).toContain("state@-4500");
    expect(kinds).toContain("emotion@-5000");
    expect(kinds).toContain("gaze@-5000");
    expect(kinds).toContain("vad@-4000");
    expect(kinds).toContain("event@-3500");
    expect(kinds).not.toContain("event@-7000"); // 1000 ms is outside ±5 s
    expect(kinds).not.toContain("event@12000");
    const tx = inc.entries.find((e) => e.kind === "event" && e.type === "assistant_transcript") as { text?: string };
    expect(tx.text?.length).toBe(200); // truncated
    expect(inc.provider).toBe("local");
    expect(inc.avatarState).toBe("SPEAKING");
    expect(inc.userOptIn).toEqual({ audio: false, video: false });
    expect(inc.micWavBase64).toBeUndefined();
    expect(inc.assistantWavBase64).toBeUndefined();
    expect(inc.videoFrameJpegBase64).toBeUndefined();
    expect(inc.hud).toEqual({ turn: 1 });
    expect(inc.sessionId).toBe("s1");
    expect(inc.note).toBe("笑顔が変");
  });

  it("attaches mic + assistant WAV only after explicit opt-in, and drops them again when opted out", () => {
    let t = 0;
    const rec = new IncidentRecorder({ sessionId: () => "s2", clock: () => t, audioMs: 1000 });
    rec.setOptIn({ audio: true });
    for (let i = 0; i < 20; i++) { t += 20; rec.recordMicFrame(createFrame(loud(), 48000, t)); rec.recordAssistantFrame(createFrame(loud(), 48000, t)); }
    const inc = rec.capture("test");
    expect(inc.userOptIn.audio).toBe(true);
    expect(inc.micWavBase64?.length ?? 0).toBeGreaterThan(1000);
    expect(inc.assistantWavBase64?.length ?? 0).toBeGreaterThan(1000);
    const bytes = Buffer.from(inc.micWavBase64!, "base64");
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes.readUInt32LE(24)).toBe(16000);
    rec.setOptIn({ audio: false });
    for (let i = 0; i < 5; i++) { t += 20; rec.recordMicFrame(createFrame(loud(), 48000, t)); }
    expect(rec.capture("again").micWavBase64).toBeUndefined();
  });

  it("wav encoder writes a valid header and metadata persistence strips media", () => {
    const b64 = int16ToWavBase64(new Int16Array([0, 1000, -1000]), 16000);
    const bytes = Buffer.from(b64, "base64");
    expect(bytes.length).toBe(44 + 6);
    expect(bytes.readUInt32LE(40)).toBe(6);
    const store = new Map<string, string>();
    saveIncidentMeta([{ id: "i", sessionId: "s", at: 1, windowMs: 10000, reason: "r", provider: null, avatarState: "IDLE", entries: [], hud: null, userOptIn: { audio: true, video: false }, micWavBase64: "AAAA", assistantWavBase64: "BBBB", videoFrameJpegBase64: "CCCC" }], { setItem: (k, v) => store.set(k, v) });
    expect(store.get("rcai.incidents.v1")).not.toMatch(/AAAA|BBBB|CCCC/);
  });

  it("submitIncident never contacts the broker under strict_local", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch;
    const inc = { id: "i", sessionId: "s", at: 1, windowMs: 10000, reason: "r", provider: null, avatarState: "IDLE", entries: [], hud: null, userOptIn: { audio: false, video: false } };
    expect(await submitIncident("http://localhost:8787", "strict_local", inc, f)).toBe("local-only");
    expect(calls).toBe(0);
    expect(await submitIncident("http://localhost:8787/", "default", inc, f)).toBe("sent");
    expect(calls).toBe(1);
  });
});
