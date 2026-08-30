import { describe, expect, it } from "vitest";
import { createFrame } from "@rcai/audio-core";
import { AvatarStateMachine } from "./stateMachine.js";
import { MotionStack, sampleCurve } from "./motion.js";
import { MotionLibrary } from "./motionLibrary.js";
import { createDefaultMotions } from "./defaultMotions.js";
import { AnalyzerLipSync } from "./lipsync.js";
import { AvatarRuntime } from "./avatarRuntime.js";
import { buildCharacterDefinition, CharacterValidationError } from "./character.js";
import { DEFAULT_EXPRESSIONS } from "./expressions.js";
import type { AvatarProvider, AvatarState } from "./types.js";

describe("AvatarStateMachine", () => {
  it("follows the basic and interruption transitions", () => {
    const m = new AvatarStateMachine(() => 0);
    expect(m.dispatch("userSpeechStarted")).toBe("LISTENING");
    expect(m.dispatch("userSpeechEnded")).toBe("THINKING");
    expect(m.dispatch("assistantSpeechStarted")).toBe("SPEAKING");
    expect(m.dispatch("assistantSpeechEnded")).toBe("IDLE");
    m.dispatch("assistantSpeechStarted");
    expect(m.dispatch("userSpeechStarted")).toBe("INTERRUPTED");
    expect(m.dispatch("userSpeechStarted")).toBe("LISTENING");
  });
  it("reaction returns to the previous state", () => {
    const m = new AvatarStateMachine(() => 0);
    m.dispatch("userSpeechStarted");
    m.dispatch("reactionStarted");
    expect(m.state).toBe("REACTING");
    expect(m.dispatch("reactionEnded")).toBe("LISTENING");
  });
});

describe("MotionStack", () => {
  it("never opens the mouth when not speaking and follows lip sync when speaking", () => {
    let t = 0;
    const s = new MotionStack(() => t);
    s.setLipSync({ mouthOpenY: 0.8, mouthForm: 0.3 });
    expect(s.compose(t).mouthOpenY).toBe(0);
    s.setSpeaking(true);
    s.setLipSync({ mouthOpenY: 0.8, mouthForm: 0.3 });
    expect(s.compose(t).mouthOpenY).toBeCloseTo(0.8);
    s.setSpeaking(false);
    expect(s.compose(t).mouthOpenY).toBe(0);
  });
  it("composes additive clips, procedural blink and emotion blend", () => {
    let t = 0;
    const s = new MotionStack(() => t);
    s.smoothing = 1000; // effectively no smoothing for the test
    const lib = new MotionLibrary().registerAll(createDefaultMotions());
    s.play("gesture", lib.get("nod_normal")!, { at: 0 });
    t = 300;
    const p1 = s.compose(t, 1000);
    expect(p1.angleY).toBeLessThan(-5);
    s.setProcedural("faceMicro", { eyeLOpen: 0.1, eyeROpen: 0.1 });
    const p2 = s.compose(t, 1000);
    expect(p2.eyeLOpen).toBeCloseTo(0.1, 1);
    s.setProcedural("faceMicro", {});
    s.setAbsolute("emotion", DEFAULT_EXPRESSIONS.smile, 1);
    const p3 = s.compose(t, 1000);
    expect(p3.eyeLSmile).toBeCloseTo(0.8, 1);
    expect(p3.cheek).toBeCloseTo(0.5, 1);
    t = 5000;
    const p4 = s.compose(t, 1000);
    expect(Math.abs(p4.angleY)).toBeLessThan(0.5); // one-shot finished
    expect(s.currentClip("gesture")).toBeNull();
  });
  it("cut() removes a layer immediately", () => {
    let t = 0;
    const s = new MotionStack(() => t);
    s.smoothing = 1000;
    const lib = new MotionLibrary().registerAll(createDefaultMotions());
    s.play("speech", lib.get("speak_energetic")!, { at: 0 });
    t = 400;
    expect(Math.abs(s.compose(t, 1000).angleY)).toBeGreaterThan(0.5);
    s.cut("speech");
    s.resetSmoothing();
    expect(Math.abs(s.compose(t, 1000).angleY)).toBeLessThan(1e-6);
  });
  it("sampleCurve interpolates with easing", () => {
    const c = [{ t: 0, v: 0 }, { t: 100, v: 10, ease: "linear" as const }];
    expect(sampleCurve(c, 50)).toBe(5);
    expect(sampleCurve(c, 200)).toBe(10);
  });
});

describe("MotionLibrary", () => {
  it("ships 30+ motions and never repeats within the history window", () => {
    const lib = new MotionLibrary(5).registerAll(createDefaultMotions());
    expect(lib.ids().length).toBeGreaterThanOrEqual(30);
    let seed = 1;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const picks: string[] = [];
    for (let i = 0; i < 40; i++) picks.push(lib.pick("reaction", { rng })!.id);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    for (let i = 5; i < picks.length; i++) {
      const window = picks.slice(i - 5, i);
      expect(window).not.toContain(picks[i]);
    }
  });
  it("falls back gracefully when a category has one clip", () => {
    const lib = new MotionLibrary(5).register({ id: "only", category: "social", durationMs: 100, loop: false, curves: {} });
    expect(lib.pick("social")!.id).toBe("only");
    expect(lib.pick("social")!.id).toBe("only");
    expect(lib.pick("teaching")).toBeNull();
  });
});

function vowel(f1: number, f2: number, ms: number, rate = 48000): Float32Array {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // glottal-ish pulse train at 140 Hz shaped by two formants
    out[i] = 0.35 * Math.sin(2 * Math.PI * f1 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 140 * t)) + 0.25 * Math.sin(2 * Math.PI * f2 * t);
  }
  return out;
}

describe("AnalyzerLipSync", () => {
  it("opens on sound, closes on silence, and distinguishes wide vs narrow vowels", () => {
    const ls = new AnalyzerLipSync();
    const feed = (data: Float32Array) => {
      for (let off = 0; off < data.length; off += 480) ls.push(createFrame(data.subarray(off, off + 480), 48000, off / 48));
    };
    feed(vowel(800, 1200, 200)); // "a"
    const a = ls.sample();
    expect(a.mouthOpenY).toBeGreaterThan(0.4);
    ls.reset();
    feed(vowel(300, 2400, 200)); // "i"
    const i = ls.sample();
    ls.reset();
    feed(vowel(300, 1400, 200)); // "u" (low F1, F2 below the wide-vowel bands)
    const u = ls.sample();
    expect(i.mouthForm).toBeGreaterThan(u.mouthForm + 0.5);
    expect(i.visemes.i).toBeGreaterThan(i.visemes.u);
    expect(u.visemes.u).toBeGreaterThan(u.visemes.i);
    ls.reset();
    feed(new Float32Array(48000 / 10));
    expect(ls.sample().mouthOpenY).toBeLessThan(0.02);
  });
  it("adapts its gain so a quiet voice (−20 dB) still opens the mouth, while near-silence stays shut", () => {
    const loud = new AnalyzerLipSync();
    const quiet = new AnalyzerLipSync();
    let ts = 0;
    const feed = (ls: AnalyzerLipSync, amp: number, ms: number) => { for (let k = 0; k < ms / 10; k++) { ls.push(createFrame(vowel(800, 1200, 10).map((v) => v * amp), 48000, ts)); ts += 10; } };
    feed(loud, 1, 300);
    feed(quiet, 0.1, 300); // −20 dB
    expect(quiet.sample().mouthOpenY).toBeGreaterThan(0.4);
    expect(quiet.sample().mouthOpenY).toBeGreaterThan(loud.sample().mouthOpenY * 0.6);
    const hiss = new AnalyzerLipSync();
    feed(hiss, 0.002, 300); // ≈ −60 dBFS
    expect(hiss.sample().mouthOpenY).toBeLessThan(0.05);
  });
  it("decays to closed when the tap stops delivering frames (playback ended)", () => {
    let wall = 0;
    const ls = new AnalyzerLipSync({ clock: () => wall });
    for (let k = 0; k < 20; k++) { ls.push(createFrame(vowel(800, 1200, 10), 48000, wall)); wall += 10; }
    expect(ls.sample().mouthOpenY).toBeGreaterThan(0.4);
    wall += 30; // < 2 windows: unchanged
    expect(ls.sample().mouthOpenY).toBeGreaterThan(0.4);
    wall += 150; // no frames for 180 ms → closed
    expect(ls.sample().mouthOpenY).toBeLessThan(0.05);
    wall += 200;
    expect(ls.sample().mouthOpenY).toBe(0);
  });
  it("releases within ~100 ms after audio stops", () => {
    const ls = new AnalyzerLipSync();
    let ts = 0;
    const push = (d: Float32Array) => { ls.push(createFrame(d, 48000, ts)); ts += 10; };
    const loud = vowel(800, 1200, 10);
    for (let k = 0; k < 20; k++) push(loud);
    expect(ls.sample().mouthOpenY).toBeGreaterThan(0.4);
    for (let k = 0; k < 10; k++) push(new Float32Array(480));
    expect(ls.sample().mouthOpenY).toBeLessThan(0.15);
  });
});

class FakeAvatar implements AvatarProvider {
  id = "fake";
  states: AvatarState[] = [];
  interrupts = 0;
  gestures: string[] = [];
  async prepare() {}
  async start() {}
  pushAudio() {}
  setState(s: AvatarState) { this.states.push(s); }
  setEmotion() {}
  performGesture(g: string) { this.gestures.push(g); }
  setGaze() {}
  interrupt() { this.interrupts++; }
  async stop() {}
}

describe("AvatarRuntime", () => {
  it("drives provider state from unified events and closes the mouth on interruption", () => {
    const fake = new FakeAvatar();
    const rt = new AvatarRuntime(fake, { clock: () => 0 });
    rt.handleEvent({ type: "user_speech_started" });
    rt.handleEvent({ type: "user_speech_ended" });
    rt.handleEvent({ type: "assistant_speech_started" });
    rt.handleEvent({ type: "user_speech_started" }); // barge-in
    expect(fake.interrupts).toBe(1);
    expect(fake.states).toEqual(["LISTENING", "THINKING", "SPEAKING", "INTERRUPTED", "LISTENING"]);
    rt.handleEvent({ type: "user_speech_ended" });
    rt.handleEvent({ type: "assistant_audio", frame: createFrame(new Float32Array(10)) });
    expect(rt.state).toBe("SPEAKING");
    rt.handleEvent({ type: "assistant_speech_ended" });
    expect(rt.state).toBe("IDLE");
    expect(fake.interrupts).toBe(2);
  });
});

describe("character definition", () => {
  const manifest = { id: "yui", name: "Yui", renderer: "live2d", defaultPersona: "friendly", supportedLanguages: ["ja-JP"], motionProfile: "expressive_v1", voiceProfiles: ["yui_openai"] };
  it("builds and validates", () => {
    const def = buildCharacterDefinition(manifest, { model: "model/yui.model3.json", voice: { voices: { openai: "marin" } }, motions: { idle: ["idle_breathe"] } }, "/characters/yui/");
    expect(def.baseUrl).toBe("/characters/yui");
    expect(def.voice.characterId).toBe("yui");
    expect(def.voice.voices.openai).toBe("marin");
  });
  it("rejects bad input", () => {
    expect(() => buildCharacterDefinition({ ...manifest, renderer: "flash" }, { model: "x", voice: { voices: {} } }, "/")).toThrow(CharacterValidationError);
    expect(() => buildCharacterDefinition(manifest, { voice: { voices: {} } }, "/")).toThrow(CharacterValidationError);
    expect(() => buildCharacterDefinition(manifest, { model: "x", voice: { voices: {} }, motions: { dance: [] } }, "/")).toThrow(/unknown motion category/);
  });
});

import { MotionStackAvatarBase } from "./motionStackAvatar.js";
class TestAvatar extends MotionStackAvatarBase {
  id = "test";
  applied: import("./types.js").AvatarParams[] = [];
  protected async loadModel() {}
  protected applyParams(p: import("./types.js").AvatarParams) { this.applied.push(p); }
  protected async disposeModel() {}
}

describe("MotionStackAvatarBase", () => {
  it("state changes pick clips, speaking drives mouth from audio, interrupt shuts the mouth immediately", async () => {
    let t = 0;
    let seed = 7;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const a = new TestAvatar({ clock: () => t, scheduler: "manual", rng });
    await a.start();
    expect(a.stack.currentClip("idle")?.category).toBe("idle");
    a.setState("LISTENING");
    expect(a.stack.currentClip("idle")?.category).toBe("listening");
    a.setState("SPEAKING");
    expect(a.stack.currentClip("speech")?.category).toBe("speaking");
    for (let i = 0; i < 30; i++) {
      a.pushAudio(createFrame(vowel(800, 1200, 10), 48000, t));
      t += 10;
      a.tick(t);
    }
    expect(a.getParams().mouthOpenY).toBeGreaterThan(0.3);
    a.interrupt();
    expect(a.getParams().mouthOpenY).toBe(0);
    expect(a.stack.currentClip("speech")).toBeNull();
    a.setState("IDLE");
    a.blink(150);
    t += 50;
    const mid = a.tick(t);
    expect(mid.eyeLOpen).toBeLessThan(0.2);
    t += 200;
    const after = a.tick(t);
    expect(after.eyeLOpen).toBeGreaterThan(0.9);
    await a.stop();
  });
});
