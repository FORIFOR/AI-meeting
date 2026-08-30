import { describe, expect, it } from "vitest";
import { AudioTap, createFrame, type AudioSink, type PCMFrame } from "@rcai/audio-core";
import { ConversationRuntime, type ConversationSource } from "./runtime.js";
import { GenerationCounter, type ConversationEvent, type ConversationEventListener, type GenerationRef } from "./events.js";
import type { SessionConfig } from "./session.js";

/** Provider that stamps generations like a real adapter and can replay late chunks of a cancelled one. */
class GenProvider implements ConversationSource {
  id = "gen";
  listener: ConversationEventListener = () => {};
  counter = new GenerationCounter("s1");
  interrupts = 0;
  async connect() {}
  pushAudio() {}
  async sendText() {}
  async interrupt() { this.interrupts++; }
  async updateContext() {}
  async disconnect() {}
  onEvent(cb: ConversationEventListener) { this.listener = cb; }
  /** Begin a response: thinking + speech start + n audio frames + transcript. Returns its generation. */
  startResponse(frames = 3): GenerationRef {
    const g = this.counter.nextGeneration();
    this.listener({ type: "assistant_thinking", gen: this.counter.stamp() });
    this.listener({ type: "assistant_speech_started", gen: this.counter.stamp() });
    for (let i = 0; i < frames; i++) this.listener({ type: "assistant_audio", frame: createFrame(new Float32Array(480)), gen: this.counter.stamp() });
    this.listener({ type: "assistant_transcript", text: `gen${g.generationId} `, final: false, gen: this.counter.stamp() });
    return g;
  }
  /** Late chunks of an old generation (what a slow network / decoder would deliver after a cancel). */
  lateChunks(g: GenerationRef, n = 10): void {
    for (let i = 0; i < n; i++) {
      const gen = { ...g, sequence: 100 + i };
      if (i % 3 === 0) this.listener({ type: "assistant_audio", frame: createFrame(new Float32Array(480)), gen });
      else if (i % 3 === 1) this.listener({ type: "assistant_transcript", text: "stale", final: false, gen });
      else this.listener({ type: "assistant_speech_started", gen });
    }
    this.listener({ type: "assistant_speech_ended", gen: { ...g, sequence: 999 } });
  }
}

class GenSink implements AudioSink {
  tap = new AudioTap();
  played: number[] = [];
  killedBelow = 0;
  isPlaying = false;
  play(_f: PCMFrame, opts?: { generationId?: number }) {
    if (opts?.generationId !== undefined && opts.generationId < this.killedBelow) return false;
    this.played.push(opts?.generationId ?? -1);
    this.isPlaying = true;
    return true;
  }
  interrupt(min?: number) { if (min !== undefined) this.killedBelow = Math.max(this.killedBelow, min); this.isPlaying = false; return 0; }
}

const config: SessionConfig = { systemPrompt: "x", mode: "free_talk", language: "ja-JP", privacyMode: "default" };

describe("generation epoch", () => {
  it("drops every late chunk of an interrupted generation (audio, caption, speaking state)", async () => {
    let t = 0;
    const sink = new GenSink();
    const rt = new ConversationRuntime({ sink, clock: () => t });
    const p = new GenProvider();
    const seen: ConversationEvent[] = [];
    const states: string[] = [];
    rt.on((e) => seen.push(e));
    rt.onStateChange((s) => states.push(s));
    await rt.start(p, config);
    const g1 = p.startResponse(3);
    expect(rt.state).toBe("speaking");
    expect(sink.played).toEqual([1, 1, 1]);
    t = 500;
    p.listener({ type: "user_speech_started", at: t }); // barge-in fast path
    expect(rt.state).toBe("listening");
    expect(p.interrupts).toBe(1); // provider cancel requested
    expect(rt.generation.accepted).toBe(2);
    const before = seen.length;
    p.lateChunks(g1, 10); // 10 late events + 1 late speech_ended
    expect(rt.stats.staleDrops).toBe(11);
    expect(seen.length).toBe(before); // nothing surfaced to listeners (UI / avatar / sidecar)
    expect(sink.played).toEqual([1, 1, 1]); // no stale playback
    expect(rt.state).toBe("listening"); // no stale speaking state
    const rec = rt.getRecord();
    expect(rec.turns.filter((x) => x.role === "assistant").map((x) => x.text)).toEqual(["gen1 "]);
    expect(rec.turns[0]?.interrupted).toBe(true);
    // The next generation passes.
    p.listener({ type: "user_speech_ended", at: 900 });
    const g2 = p.startResponse(2);
    expect(g2.generationId).toBe(2);
    expect(rt.state).toBe("speaking");
    expect(sink.played).toEqual([1, 1, 1, 2, 2]);
    expect(seen.filter((e) => e.type === "assistant_transcript").map((e) => (e as { text: string }).text)).toEqual(["gen1 ", "gen2 "]);
  });

  it("provider-confirmed interruption bumps the epoch even without the fast path", async () => {
    const sink = new GenSink();
    const rt = new ConversationRuntime({ sink, clock: () => 0 });
    const p = new GenProvider();
    await rt.start(p, config);
    const g1 = p.startResponse(2);
    p.listener({ type: "interrupted", gen: g1 }); // server VAD / response.cancel confirmation
    expect(rt.state).toBe("idle");
    p.lateChunks(g1, 6);
    expect(rt.stats.staleDrops).toBe(7);
    expect(sink.played.length).toBe(2);
    expect(rt.state).toBe("idle");
  });

  it("100 consecutive barge-ins with random late chunks: zero stale playback / caption / state", async () => {
    let t = 0;
    const sink = new GenSink();
    const rt = new ConversationRuntime({ sink, clock: () => t });
    const p = new GenProvider();
    const captions: string[] = [];
    let staleSpeaking = 0;
    let listeningPhase = false;
    rt.on((e) => {
      if (e.type === "assistant_transcript") captions.push(e.text);
      if (listeningPhase && (e.type === "assistant_speech_started" || e.type === "assistant_audio")) staleSpeaking++;
    });
    await rt.start(p, config);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let stalePlayed = 0;
    for (let i = 0; i < 100; i++) {
      listeningPhase = false;
      p.listener({ type: "user_speech_started", at: t });
      p.listener({ type: "user_speech_ended", at: (t += 100) });
      const g = p.startResponse(1 + Math.floor(rnd() * 4));
      expect(rt.state).toBe("speaking");
      const playedBefore = sink.played.length;
      t += 50;
      p.listener({ type: "user_speech_started", at: t }); // barge-in
      listeningPhase = true;
      expect(rt.state).toBe("listening");
      const n = Math.floor(rnd() * 12);
      p.lateChunks(g, n);
      // Sometimes even a whole late "new" response with the OLD generation id must be dropped too.
      if (rnd() < 0.3) p.listener({ type: "assistant_speech_started", gen: { ...g, sequence: 500 } });
      stalePlayed += sink.played.length - playedBefore;
      expect(rt.state).toBe("listening");
      p.listener({ type: "user_speech_ended", at: (t += 100) });
      t += 100;
    }
    expect(stalePlayed).toBe(0);
    expect(staleSpeaking).toBe(0);
    expect(captions.every((c) => c !== "stale")).toBe(true);
    expect(captions.length).toBe(100);
    expect(rt.stats.interruptions).toBe(100);
    expect(rt.stats.staleDrops).toBeGreaterThan(100);
    expect(rt.generation.accepted).toBe(101);
  });

  it("switching provider resets the accepted generation for the new provider's counters", async () => {
    const rt = new ConversationRuntime({ clock: () => 0 });
    const a = new GenProvider();
    const b = new GenProvider();
    b.id = "b";
    await rt.start(a, config);
    const g = a.startResponse(1);
    a.listener({ type: "user_speech_started" });
    expect(rt.generation.accepted).toBe(2);
    await rt.switchProvider(b);
    expect(rt.generation.accepted).toBe(0);
    b.startResponse(1); // generation 1 of provider b is accepted
    expect(rt.state).toBe("speaking");
    expect(g.sessionId).toBe("s1");
  });
});
