import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { SessionObserver } from "./observer.js";
import { Samples, summarize } from "./stats.js";

const frame = (level: number) => createFrame(new Float32Array(160).fill(level), 16000);
describe("browser timing boundaries", () => {
  it("measures subtitle and played signal independently and ignores interim duplicates", () => {
    let t = 0; const o = new SessionObserver({ sessionId: "test", clock: () => t });
    o.handleEvent({ type: "user_speech_ended", at: 100 });
    t = 300; o.handleEvent({ type: "assistant_transcript", text: "", final: false });
    t = 400; o.handleEvent({ type: "assistant_transcript", text: "private phrase", final: false });
    o.handleEvent({ type: "assistant_speech_started", at: 500 });
    o.notePlaybackFrame(frame(0), 510); o.notePlaybackFrame(frame(.1), 540);
    t = 700; o.handleEvent({ type: "assistant_transcript", text: "private phrase", final: true });
    o.notePlaybackFrame(frame(.1), 750);
    const r = o.toReport();
    expect(r.browserTiming.samples).toEqual({ subtitleArrival: [300], playbackSignal: [440], interruptionSilence: [] });
    expect(JSON.stringify(r)).not.toContain("private phrase");
  });
  it("observes sustained output silence after barge-in, not stop-command execution time", () => {
    const o = new SessionObserver({ sessionId: "test", clock: () => 0 });
    o.notePlaybackFrame(frame(.1), 100);
    o.handleEvent({ type: "user_speech_started", at: 105 });
    o.handleEvent({ type: "interrupted", at: 106 });
    o.notePlaybackFrame(frame(0), 110); o.notePlaybackFrame(frame(.1), 120);
    for (const t of [130, 140, 150, 160]) o.notePlaybackFrame(frame(0), t);
    expect(o.toReport().browserTiming.samples.interruptionSilence).toEqual([45]);
    o.handleEvent({ type: "interrupted", at: 170 });
    for (const t of [180, 190, 200]) o.notePlaybackFrame(frame(0), t);
    expect(o.toReport().browserTiming.samples.interruptionSilence).toEqual([45]);
    const natural = new SessionObserver({ sessionId: "natural", clock: () => 0 });
    natural.notePlaybackFrame(frame(.1), 100);
    natural.handleEvent({ type: "user_speech_started", at: 105 });
    for (const t of [110, 120, 130]) natural.notePlaybackFrame(frame(0), t);
    expect(natural.toReport().browserTiming.samples.interruptionSilence).toEqual([]);
    const reordered = new SessionObserver({ sessionId: "reordered", clock: () => 0 });
    reordered.notePlaybackFrame(frame(.1), 100);
    reordered.handleEvent({ type: "interrupted", at: 105 });
    reordered.handleEvent({ type: "user_speech_started", at: 105 });
    for (const t of [110, 120, 130]) reordered.notePlaybackFrame(frame(0), t);
    expect(reordered.toReport().browserTiming.samples.interruptionSilence).toEqual([25]);
  });
  it("does not invent a stop sample without prior playback or reuse a superseded turn", () => {
    let t = 0; const o = new SessionObserver({ sessionId: "test", clock: () => t });
    o.handleEvent({ type: "user_speech_ended", at: 100 });
    o.handleEvent({ type: "user_speech_started", at: 200 });
    o.handleEvent({ type: "assistant_speech_started", at: 210 });
    t = 220; o.handleEvent({ type: "assistant_transcript", text: "old", final: true });
    for (const t of [230, 240, 250]) o.notePlaybackFrame(frame(0), t);
    o.notePlaybackFrame(frame(.1), 260);
    expect(o.toReport().browserTiming.samples).toEqual({ subtitleArrival: [], playbackSignal: [], interruptionSilence: [] });
    expect(o.toReport().responseLatency.count).toBe(0);
  });
  it("exposes p99, empty observations and bounded-sample loss", () => {
    expect(summarize(Array.from({ length: 100 }, (_, i) => i + 1)).p99).toBe(99);
    expect(summarize([]).p99).toBeNaN();
    const s = new Samples(2); [1, 2, 3].forEach(n => s.push(n));
    expect(s.all()).toEqual([2, 3]); expect(s.dropped).toBe(1);
  });
});
