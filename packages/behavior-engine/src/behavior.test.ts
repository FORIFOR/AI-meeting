import { describe, expect, it } from "vitest";
import { AvatarRuntime, type AvatarParams, type AvatarProvider, type AvatarState, type MotionCategory } from "@rcai/avatar-core";
import { BlinkController } from "./micro.js";
import { ListeningScheduler } from "./listening.js";
import { planHeuristically, RemoteSemanticPlanner } from "./planner.js";
import { BehaviorEngine } from "./engine.js";
import { createRng } from "./rng.js";

class SpyAvatar implements AvatarProvider {
  id = "spy";
  calls: string[] = [];
  blinks: number[] = [];
  gestures: string[] = [];
  motions: { category: MotionCategory; tags?: string[] }[] = [];
  micro: Partial<AvatarParams> = {};
  async prepare() {}
  async start() {}
  pushAudio() {}
  setState(s: AvatarState) { this.calls.push(`state:${s}`); }
  setEmotion(e: string, i: number) { this.calls.push(`emotion:${e}:${i.toFixed(2)}`); }
  performGesture(g: string, i: number) { this.gestures.push(g); this.calls.push(`gesture:${g}:${i.toFixed(2)}`); }
  setGaze(t: { kind: string }) { this.calls.push(`gaze:${t.kind}`); }
  interrupt() { this.calls.push("interrupt"); }
  async stop() {}
  blink(ms?: number) { this.blinks.push(ms ?? 0); }
  setMicroMotion(p: Partial<AvatarParams>) { this.micro = p; }
  playMotion(category: MotionCategory, opts?: { tags?: string[] }) { this.motions.push({ category, tags: opts?.tags }); }
}

describe("BlinkController", () => {
  it("produces non-mechanical intervals (variance, double blinks, thinking speeds up)", () => {
    const rng = createRng(42);
    let now = 0;
    const b = new BlinkController(rng, now);
    const intervals: number[] = [];
    let last = 0;
    while (now < 300_000) {
      now += 16;
      if (b.update(now, "IDLE") !== null) { intervals.push(now - last); last = now; }
    }
    const mean = intervals.reduce((a, c) => a + c, 0) / intervals.length;
    const sd = Math.sqrt(intervals.reduce((a, c) => a + (c - mean) ** 2, 0) / intervals.length);
    expect(mean).toBeGreaterThan(2500);
    expect(mean).toBeLessThan(6500);
    expect(sd / mean).toBeGreaterThan(0.3); // clearly not a fixed metronome
    expect(intervals.some((i) => i < 400)).toBe(true); // double blinks exist
    const uniq = new Set(intervals.map((i) => Math.round(i / 100)));
    expect(uniq.size).toBeGreaterThan(10);
  });
});

describe("ListeningScheduler", () => {
  it("nods during long speech without repeating the same gesture constantly", () => {
    const rng = createRng(7);
    const s = new ListeningScheduler(rng);
    s.reset(0);
    const kinds: string[] = [];
    let last: string | undefined;
    for (let t = 250; t < 60_000; t += 250) {
      const a = s.next(t, { elapsedMs: t, sinceUserAudioMs: t % 4000 < 500 ? 600 : 50, userEnergy: 0.6, transcript: t % 5000 < 250 ? "そうなんです。" : "えっと", lastAction: last as never });
      if (a) { kinds.push(a.kind); last = a.kind; }
    }
    expect(kinds.filter((k) => k === "tiny_nod").length).toBeGreaterThan(5);
    expect(kinds.filter((k) => k === "tiny_nod").length).toBeLessThan(40);
    let maxRun = 0, run = 0;
    for (let i = 0; i < kinds.length; i++) { run = i > 0 && kinds[i] === kinds[i - 1] ? run + 1 : 1; maxRun = Math.max(maxRun, run); }
    expect(maxRun).toBeLessThanOrEqual(4);
    expect(new Set(kinds).size).toBeGreaterThanOrEqual(2);
  });
});

describe("planHeuristically", () => {
  it("maps Japanese assistant text to emotion/gesture and detects questions", () => {
    const p = planHeuristically({ speaker: "assistant", text: "それは、とても良い回答ですね。", mode: "english_lesson" });
    expect(p.emotion).toBe("warm_positive");
    expect(p.gesture).toBe("nod_normal");
    expect(p.energy).toBeGreaterThan(0.4);
    const q = planHeuristically({ speaker: "assistant", text: "なぜその会社を選んだのですか？", mode: "interview" });
    expect(q.question).toBe(true);
    expect(q.gesture).toBe("head_tilt");
    expect(q.energy).toBeLessThanOrEqual(0.55);
    const c = planHeuristically({ speaker: "assistant", text: "それは大変でしたね。", mode: "free_talk" });
    expect(c.emotion).toBe("concerned");
  });
  it("remote planner falls back to heuristic on failure and never throws", async () => {
    const failing = new RemoteSemanticPlanner("http://127.0.0.1:9/plan", 50, (async () => { throw new Error("down"); }) as unknown as typeof fetch);
    const p = await failing.plan({ speaker: "assistant", text: "すごい！", mode: "free_talk" });
    expect(p.emotion).toBe("surprised");
    const ok = new RemoteSemanticPlanner("http://x/plan", 50, (async () => new Response(JSON.stringify({ emotion: "laugh", gesture: "celebrate", energy: 2 }))) as unknown as typeof fetch);
    const r = await ok.plan({ speaker: "assistant", text: "x", mode: "free_talk" });
    expect(r.emotion).toBe("laugh");
    expect(r.energy).toBe(1);
  });
});

describe("BehaviorEngine", () => {
  it("keeps the avatar alive while listening and applies semantic plans asynchronously", async () => {
    let now = 0;
    const spy = new SpyAvatar();
    const rt = new AvatarRuntime(spy, { clock: () => now });
    const engine = new BehaviorEngine(rt, { seed: 3, clock: () => now, scheduler: "manual", mode: "free_talk" });
    engine.start();
    rt.handleEvent({ type: "user_speech_started" });
    engine.handleEvent({ type: "user_transcript", text: "昨日ちょっと大変なことがあって", final: false });
    for (let i = 0; i < 20_000 / 16; i++) { now += 16; engine.reportUserAudio(0.6, now); engine.tick(now); }
    expect(spy.blinks.length).toBeGreaterThan(2);
    expect(spy.gestures.length).toBeGreaterThan(1); // nods / tilts while listening
    expect(spy.micro.breath).toBeDefined();
    expect(spy.calls.some((c) => c.startsWith("gaze:away") || c.startsWith("gaze:user"))).toBe(true);

    rt.handleEvent({ type: "user_speech_ended" });
    rt.handleEvent({ type: "assistant_speech_started" });
    engine.handleEvent({ type: "assistant_speech_started" });
    const before = spy.calls.length;
    engine.handleEvent({ type: "assistant_transcript", text: "それは、とても良い回答ですね。", final: false });
    // Fast tier is synchronous; the semantic tier resolves on the microtask queue — audio never waits.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(spy.calls.slice(before)).toContain("emotion:warm_positive:0.71");
    expect(spy.gestures).toContain("nod_normal");
    expect(spy.motions.some((m) => m.category === "speaking")).toBe(true);
    // Question → eyebrow raise immediately.
    engine.handleEvent({ type: "assistant_transcript", text: "どう思いますか？", final: false });
    expect(spy.gestures).toContain("eyebrow_raise");
    engine.stop();
  });
  it("interruption cancels stale plans", async () => {
    let now = 0;
    const spy = new SpyAvatar();
    const rt = new AvatarRuntime(spy, { clock: () => now });
    let resolvePlan: ((p: unknown) => void) | null = null;
    const planner = { plan: () => new Promise<never>((res) => { resolvePlan = res as never; }) };
    const engine = new BehaviorEngine(rt, { seed: 1, clock: () => now, scheduler: "manual", planner: planner as never });
    engine.start();
    rt.handleEvent({ type: "assistant_speech_started" });
    engine.handleEvent({ type: "assistant_speech_started" });
    engine.handleEvent({ type: "assistant_transcript", text: "おめでとうございます！" });
    rt.handleEvent({ type: "user_speech_started" });
    engine.handleEvent({ type: "interrupted" });
    const n = spy.gestures.length;
    resolvePlan!({ emotion: "laugh", emotionIntensity: 0.9, gesture: "celebrate", gestureIntensity: 0.9, energy: 0.9 });
    await new Promise((r) => setTimeout(r, 0));
    expect(spy.gestures.length).toBe(n); // stale plan discarded
    engine.stop();
  });
});

import { classifyListener, ListenerSemantics } from "./listenerSemantics.js";

describe("ListenerSemantics", () => {
  it("classifies user speech categories", () => {
    expect(classifyListener("実はそのプロジェクトは失敗してしまって……").category).toBe("emotional_negative");
    expect(classifyListener("前職では5人のチームをまとめていました").category).toBe("positive");
    expect(classifyListener("えっと、たぶん…").category).toBe("uncertain");
    expect(classifyListener("納期が遅れてクレームになりました").category).toBe("serious");
    expect(classifyListener("実は突然、部長に呼ばれて").category).toBe("surprising");
    expect(classifyListener("今日は天気がいいですね").category).toBe("neutral");
    // failure inside an otherwise positive sentence stays negative
    const mixed = classifyListener("改善を頑張ったんですが、結局うまくいかなくて");
    expect(mixed.category).toBe("emotional_negative");
    expect(mixed.suppressSmile).toBe(true);
    expect(classifyListener("we actually failed the launch").category).toBe("emotional_negative");
    expect(classifyListener("I'm not sure, maybe").category).toBe("uncertain");
  });

  it("never smiles at a failure story; nods warmly at an achievement; tilts at hesitation — all on the same tick", () => {
    let now = 0;
    const spy = new SpyAvatar();
    const rt = new AvatarRuntime(spy, { clock: () => now });
    const engine = new BehaviorEngine(rt, { seed: 5, clock: () => now, scheduler: "manual", mode: "interview" });
    engine.start();
    rt.handleEvent({ type: "user_speech_started" });
    const before = spy.calls.length;
    engine.handleEvent({ type: "user_transcript", text: "実はそのプロジェクトは失敗してしまって……", final: false });
    const sync = spy.calls.slice(before); // no await: must be applied synchronously
    expect(sync.some((c) => c.startsWith("emotion:concerned") || c.startsWith("emotion:serious"))).toBe(true);
    expect(sync.some((c) => /emotion:(smile|laugh|happy|warm_positive)/.test(c))).toBe(false);
    expect(spy.gestures).not.toContain("happy");
    expect(spy.gestures).not.toContain("laugh_soft");
    expect(sync.some((c) => c === "gaze:down")).toBe(true);
    engine.handleEvent({ type: "user_transcript", text: "実はそのプロジェクトは失敗してしまって……", final: true });
    // Long listening: nods stay small, never happy/laugh gestures.
    for (let i = 0; i < 12000 / 16; i++) { now += 16; engine.reportUserAudio(0.5, now); engine.tick(now); }
    expect(spy.gestures.filter((g) => g === "happy" || g === "laugh_soft" || g === "celebrate").length).toBe(0);
    expect(spy.calls.some((c) => /emotion:(smile|laugh|happy)/.test(c))).toBe(false);
    expect(spy.gestures.every((g) => g === "nod_small" || g === "eyebrow_raise" || g === "head_tilt" || g === "nod_normal")).toBe(true);
    expect(spy.gestures.filter((g) => g === "nod_normal").length).toBe(0); // grave content → no strong nods

    // New turn: achievement → warm + nod
    rt.handleEvent({ type: "user_speech_ended" });
    rt.handleEvent({ type: "assistant_speech_started" });
    rt.handleEvent({ type: "assistant_speech_ended" });
    rt.handleEvent({ type: "user_speech_started" });
    const b2 = spy.calls.length;
    engine.handleEvent({ type: "user_transcript", text: "前職では5人のチームをまとめていました", final: false });
    const s2 = spy.calls.slice(b2);
    expect(s2.some((c) => c.startsWith("emotion:warm_positive"))).toBe(true);
    expect(s2.some((c) => c.startsWith("gesture:nod_"))).toBe(true);

    // Hesitation → head tilt (a new turn a few seconds later; gestures are debounced 1.5 s)
    now += 3000;
    rt.handleEvent({ type: "user_speech_ended" });
    rt.handleEvent({ type: "assistant_speech_started" });
    rt.handleEvent({ type: "assistant_speech_ended" });
    rt.handleEvent({ type: "user_speech_started" });
    const b3 = spy.calls.length;
    engine.handleEvent({ type: "user_transcript", text: "えっと、たぶん…", final: false });
    const s3 = spy.calls.slice(b3);
    expect(s3.some((c) => c.startsWith("gesture:head_tilt"))).toBe(true);
    expect(s3.some((c) => c.startsWith("emotion:thinking"))).toBe(true);
    engine.stop();
  });

  it("debounces partial revisions and remembers the category for the scheduler", () => {
    let now = 0;
    const ls = new ListenerSemantics(() => now);
    const a = ls.update("えっと", false);
    expect(a.expression?.category).toBe("uncertain");
    now += 100;
    const b = ls.update("えっと、たぶん", false);
    expect(b.expression).toBeNull(); // same category, no flicker
    now += 100;
    const c = ls.update("えっと、たぶん失敗しました", false);
    expect(c.expression?.category).toBe("emotional_negative");
    expect(ls.reading.nodRate).toBeLessThan(1);
  });
});
