import { describe, expect, it } from "vitest";
import { assessCompleteness, EndpointPolicy } from "./endpointing.js";
import { IncrementalOfflineSTT } from "./adapters/stt-streaming.js";
import { commonPrefix } from "@rcai/provider-core";
import type { STTAdapter } from "./adapters/stt.js";

describe("assessCompleteness (ja)", () => {
  const complete = ["今日はいい天気ですね", "はい、私の強みは粘り強さです", "半年かけて改善しました", "お願いします", "行きたいです", "大丈夫でしょうか", "それは違うと思います", "そうなんですよ", "楽しかった。", "本当ですか？", "できません", "頑張りましょう"];
  const incomplete = ["前職ではチームをまとめていたんですけど", "昨日は雨だったので", "えっと", "あのー", "それで、", "処理時間を三", "東京と", "資料を", "私は", "会議が終わって", "うーん", "なんか"];
  it.each(complete)("complete: %s", (t) => expect(assessCompleteness(t).score).toBeGreaterThanOrEqual(0.65));
  it.each(incomplete)("incomplete: %s", (t) => expect(assessCompleteness(t).score).toBeLessThan(0.4));
  it("ignores ASR-appended terminal punctuation and token spaces (SenseVoice)", () => {
    expect(assessCompleteness("今日は 雨 だっ た の で。").score).toBeLessThan(0.4);
    expect(assessCompleteness("私は？").score).toBeLessThan(0.4);
    expect(assessCompleteness(" て いたん です けど。").reason).toBe("trailing_particle");
    expect(assessCompleteness("して 働い て、います。").score).toBeGreaterThanOrEqual(0.8);
    expect(assessCompleteness("理由 は 何 で すか？").reason).toBe("final_form");
    expect(assessCompleteness("東京？").score).toBe(0.6);
    expect(assessCompleteness("そうですね。", "ja", { trustPunctuation: true }).reason).toBe("punct");
  });
  it("labels reasons", () => {
    expect(assessCompleteness("そうですね。").reason).toBe("final_form");
    expect(assessCompleteness("えっと").reason).toBe("filler");
    expect(assessCompleteness("昨日は雨だったけど").reason).toBe("trailing_particle");
    expect(assessCompleteness("処理時間を三").reason).toBe("dangling_number");
    expect(assessCompleteness("").reason).toBe("empty");
  });
});

describe("assessCompleteness (en)", () => {
  it("handles conjunctions, fillers and terminal punctuation", () => {
    expect(assessCompleteness("I worked there for five years and", "en").score).toBeLessThan(0.4);
    expect(assessCompleteness("I think, um", "en").score).toBeLessThan(0.4);
    expect(assessCompleteness("I worked there for five years.", "en").score).toBeGreaterThan(0.8);
    expect(assessCompleteness("I was the team lead", "en").score).toBeGreaterThanOrEqual(0.5);
  });
});

describe("EndpointPolicy", () => {
  it("ends a complete, stable utterance after the minimum silence only", () => {
    const p = new EndpointPolicy();
    expect(p.evaluate({ speaking: false, silenceMs: 200, text: "今日はいい天気ですね", stable: true }).decision).not.toBe("endpoint");
    const d = p.evaluate({ speaking: false, silenceMs: 245, text: "今日はいい天気ですね", stable: true });
    expect(d.decision).toBe("endpoint");
    expect(d.reason).toBe("final_form");
  });
  it("needs more silence when the transcript is still moving", () => {
    const p = new EndpointPolicy();
    expect(p.evaluate({ speaking: false, silenceMs: 260, text: "今日はいい天気ですね", stable: false }).decision).not.toBe("endpoint");
    expect(p.evaluate({ speaking: false, silenceMs: 330, text: "今日はいい天気ですね", stable: false }).decision).toBe("endpoint");
  });
  it("waits long after trailing particles / fillers and always ends at the cap", () => {
    const p = new EndpointPolicy();
    expect(p.evaluate({ speaking: false, silenceMs: 500, text: "前職ではチームをまとめていたんですけど", stable: true }).decision).toBe("continue");
    expect(p.evaluate({ speaking: false, silenceMs: 810, text: "前職ではチームをまとめていたんですけど", stable: true }).decision).toBe("endpoint");
    expect(p.evaluate({ speaking: false, silenceMs: 850, text: "えっと", stable: true }).decision).toBe("continue");
    expect(p.evaluate({ speaking: false, silenceMs: 900, text: "えっと", stable: true }).reason).toBe("max_silence");
  });
  it("never ends while speaking; reports soft_endpoint near the threshold", () => {
    const p = new EndpointPolicy();
    expect(p.evaluate({ speaking: true, silenceMs: 5000, text: "はい", stable: true }).decision).toBe("continue");
    const d = p.evaluate({ speaking: false, silenceMs: 200, text: "お願いします", stable: true });
    expect(d.decision).toBe("soft_endpoint");
    expect(d.waitMs).toBe(40);
  });
  it("unknown endings use the middle band", () => {
    const p = new EndpointPolicy();
    expect(p.evaluate({ speaking: false, silenceMs: 400, text: "東京", stable: true }).decision).toBe("continue");
    expect(p.evaluate({ speaking: false, silenceMs: 530, text: "東京", stable: true }).decision).toBe("endpoint");
  });
  it("adapts after premature endpoints and decays after clean ones", () => {
    const p = new EndpointPolicy();
    p.notePrematureEndpoint();
    expect(p.adaptiveOffsetMs).toBe(80);
    expect(p.evaluate({ speaking: false, silenceMs: 300, text: "今日はいい天気ですね", stable: true }).decision).not.toBe("endpoint");
    expect(p.evaluate({ speaking: false, silenceMs: 325, text: "今日はいい天気ですね", stable: true }).decision).toBe("endpoint");
    for (let i = 0; i < 10; i++) p.notePrematureEndpoint();
    expect(p.adaptiveOffsetMs).toBe(500);
    for (let i = 0; i < 3; i++) p.noteCleanEndpoint();
    expect(p.adaptiveOffsetMs).toBe(480);
    // cap: even incomplete + offset never exceeds max
    expect(p.requiredSilence("けど", true).ms).toBe(900);
  });
});

class FakeSTT implements STTAdapter {
  engine = "fake"; ready = true; model = "fake";
  calls: number[] = [];
  constructor(private readonly delayMs = 0) {}
  async transcribe(samples: Float32Array): Promise<string> {
    this.calls.push(samples.length);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const secs = samples.length / 16000;
    // text grows with audio: 1 char per 100 ms
    return "あ".repeat(Math.floor(secs * 10));
  }
}

describe("IncrementalOfflineSTT", () => {
  it("decodes while audio arrives, exposes a stable prefix and reuses a fresh final", async () => {
    const base = new FakeSTT();
    const stt = new IncrementalOfflineSTT(base, { intervalMs: 300, minAudioMs: 400, reuseTailMs: 150 });
    stt.start("ja-JP");
    const seen: string[] = [];
    stt.onTranscript((t) => seen.push(`${t.kind}:${t.text.length}`));
    const chunk = new Float32Array(320); // 20 ms
    for (let i = 0; i < 50; i++) { stt.pushAudio(chunk); if (i % 5 === 4) await new Promise((r) => setTimeout(r, 1)); } // 1.0 s in real-time-ish pushes
    await new Promise((r) => setTimeout(r, 5));
    expect(stt.partials).toBeGreaterThanOrEqual(2);
    expect(seen.some((s) => s.startsWith("stable:"))).toBe(true);
    for (let i = 0; i < 5; i++) stt.pushAudio(chunk); // +100 ms (< reuse tail)
    await new Promise((r) => setTimeout(r, 5));
    const callsBefore = base.calls.length;
    const final = await stt.endUtterance();
    expect(final.kind).toBe("final");
    expect(final.reused).toBe(true);
    expect(base.calls.length).toBe(callsBefore); // no post-end decode
  });
  it("decodes once more when the last partial is stale, and skips decodes while busy", async () => {
    const base = new FakeSTT(30);
    const stt = new IncrementalOfflineSTT(base, { intervalMs: 300, minAudioMs: 400, reuseTailMs: 150 });
    stt.start("ja-JP");
    const chunk = new Float32Array(1600); // 100 ms
    for (let i = 0; i < 12; i++) stt.pushAudio(chunk); // 1.2 s pushed synchronously while the first decode is in flight
    expect(base.calls.length).toBe(1); // busy → skipped
    await new Promise((r) => setTimeout(r, 40));
    const final = await stt.endUtterance();
    expect(final.reused).toBe(false);
    expect(final.text.length).toBe(12);
  });
  it("commonPrefix", () => {
    expect(commonPrefix("今日はいい天気", "今日はいい天気ですね")).toBe("今日はいい天気");
    expect(commonPrefix("abc", "xyz")).toBe("");
  });
});
