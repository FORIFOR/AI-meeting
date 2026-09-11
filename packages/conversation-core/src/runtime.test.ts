import { describe, expect, it } from "vitest";
import { createFrame, type AudioSink, AudioTap, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationSource } from "./runtime.js";
import type { ConversationEvent, ConversationEventListener } from "./events.js";
import type { SessionConfig } from "./session.js";

class FakeProvider implements ConversationSource {
  id = "fake";
  listener: ConversationEventListener = () => {};
  pushed: PCMFrame[] = [];
  interrupts = 0;
  async connect() {}
  pushAudio(f: PCMFrame) { this.pushed.push(f); }
  async sendText() {}
  async interrupt() { this.interrupts++; }
  async updateContext() {}
  async disconnect() {}
  onEvent(cb: ConversationEventListener) { this.listener = cb; }
  emit(e: ConversationEvent) { this.listener(e); }
}

class FakeSink implements AudioSink {
  tap = new AudioTap();
  played = 0;
  interrupted = 0;
  resumed = 0;
  isPlaying = false;
  play() { this.played++; this.isPlaying = true; }
  interrupt() { this.interrupted++; this.isPlaying = false; return 0; }
  resumeStream() { this.resumed++; }
}

const config: SessionConfig = { systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" };

describe("ConversationRuntime", () => {
  it("follows the basic turn state machine and records turns + latency", async () => {
    let t = 0;
    const sink = new FakeSink();
    const rt = new ConversationRuntime({ sink, clock: () => t });
    const p = new FakeProvider();
    const states: string[] = [];
    rt.onStateChange((s) => states.push(s));
    await rt.start(p, config);

    p.emit({ type: "user_speech_started" });
    t = 1500;
    p.emit({ type: "user_speech_ended" });
    p.emit({ type: "user_transcript", text: "こんにちは" });
    t = 2100;
    p.emit({ type: "assistant_speech_started" });
    p.emit({ type: "assistant_audio", frame: createFrame(new Float32Array(480)) });
    p.emit({ type: "assistant_transcript", text: "やあ、元気？" });
    t = 3500;
    p.emit({ type: "assistant_speech_ended" });

    expect(states).toEqual(["listening", "thinking", "speaking", "idle"]);
    expect(sink.played).toBe(1);
    const rec = await rt.stop();
    expect(rec.turns.map((x) => [x.role, x.text])).toEqual([["user", "こんにちは"], ["assistant", "やあ、元気？"]]);
    expect(rec.timing.responseLatenciesMs).toEqual([600]);
    expect(rt.latency.summary("turn_response").p50).toBe(600);
  });

  it("stops local audio immediately when the user interrupts", async () => {
    let t = 0;
    const sink = new FakeSink();
    const rt = new ConversationRuntime({ sink, clock: () => t });
    const p = new FakeProvider();
    const events: string[] = [];
    rt.on((e) => events.push(e.type));
    await rt.start(p, config);
    p.emit({ type: "assistant_speech_started" });
    p.emit({ type: "assistant_audio", frame: createFrame(new Float32Array(480)) });
    expect(sink.isPlaying).toBe(true);
    t = 500;
    p.emit({ type: "user_speech_started" });
    expect(sink.interrupted).toBeGreaterThanOrEqual(1);
    expect(sink.isPlaying).toBe(false);
    expect(rt.state).toBe("listening");
    expect(events).toContain("interrupted");
    const rec = rt.getRecord();
    expect(rec.interruptions.byUser).toBe(1);
    expect(rec.turns[0]?.interrupted).toBe(true);
    // A muted WebRTC stream is re-enabled when the next assistant turn starts.
    p.emit({ type: "user_speech_ended" });
    p.emit({ type: "assistant_speech_started" });
    expect(sink.resumed).toBe(2);
  });

  it.each(["pending", "rejected"])("tap interruption completes locally with a %s network cancel", async (failure) => {
    const sink = new FakeSink(), p = new FakeProvider();
    p.interrupt = () => failure === "pending" ? new Promise<void>(() => {}) : Promise.reject(new Error("offline"));
    const rt = new ConversationRuntime({ sink });
    const events: string[] = [];
    rt.on(e => events.push(e.type));
    await rt.start(p, config);
    p.emit({ type: "assistant_audio", frame: createFrame(new Float32Array(480)) });
    const stopped = rt.interrupt();
    expect(sink.isPlaying).toBe(false);
    expect(rt.state).toBe("idle");
    expect(events).toContain("interrupted");
    await stopped;
    expect(rt.getRecord().turns[0]?.interrupted).toBe(true);
    await rt.stop();
  });

  it("preserves full-duplex speech during an acknowledgment but still supports explicit interrupt", async()=>{
    const sink=new FakeSink(), p=Object.assign(new FakeProvider(),{fullDuplex:true});
    const rt=new ConversationRuntime({sink});await rt.start(p,config);
    p.emit({type:"assistant_audio",frame:createFrame(new Float32Array(480))});
    p.emit({type:"user_speech_started"});p.emit({type:"user_speech_ended"});
    expect(p.interrupts).toBe(0);expect(sink.isPlaying).toBe(true);expect(rt.state).toBe("speaking");
    await rt.interrupt();expect(sink.isPlaying).toBe(false);expect(p.interrupts).toBe(1);
  });

  it("derives speaking state from audio when provider has no explicit start event", async () => {
    const rt = new ConversationRuntime({ sink: new FakeSink(), clock: () => 0 });
    const p = new FakeProvider();
    await rt.start(p, config);
    p.emit({ type: "assistant_audio", frame: createFrame(new Float32Array(480)) });
    expect(rt.state).toBe("speaking");
  });

  it("emits local VAD user events and forwards mic frames to the provider", async () => {
    let t = 0;
    const rt = new ConversationRuntime({ localVad: true, clock: () => t });
    const p = new FakeProvider();
    const seen: string[] = [];
    rt.on((e) => seen.push(e.type));
    await rt.start(p, config);
    const loud = new Float32Array(960);
    for (let i = 0; i < loud.length; i++) loud[i] = 0.5 * Math.sin(i / 10);
    const quiet = new Float32Array(960).fill(0.0005);
    for (let i = 0; i < 20; i++) { rt.pushMicFrame(createFrame(quiet, 48000, t)); t += 20; }
    for (let i = 0; i < 15; i++) { rt.pushMicFrame(createFrame(loud, 48000, t)); t += 20; }
    for (let i = 0; i < 40; i++) { rt.pushMicFrame(createFrame(quiet, 48000, t)); t += 20; }
    expect(seen).toEqual(["user_speech_started", "user_speech_ended"]);
    expect(p.pushed.length).toBe(75);
    expect(rt.state).toBe("thinking");
  });

  it("switches provider without losing config", async () => {
    const rt = new ConversationRuntime({ clock: () => 0 });
    const a = new FakeProvider();
    const b = new FakeProvider();
    b.id = "b";
    await rt.start(a, config);
    await rt.switchProvider(b);
    expect(rt.currentProvider?.id).toBe("b");
    expect(rt.getRecord().providerId).toBe("b");
  });

  it("hidden text is neither recorded nor surfaced when echoed by the provider", async () => {
    const rt = new ConversationRuntime({ clock: () => 0 });
    const p = new FakeProvider();
    const seen: string[] = [];
    rt.on((e) => seen.push(e.type));
    await rt.start(p, config);
    await rt.sendText("(start now)", { hidden: true });
    p.emit({ type: "user_transcript", text: "(start now)", final: true });
    await rt.sendText("visible");
    p.emit({ type: "user_transcript", text: "visible", final: true });
    expect(seen.filter((t) => t === "user_transcript").length).toBe(1);
    expect(rt.getRecord().turns.map((t) => t.text)).toEqual(["visible", "visible"]);
  });
});
