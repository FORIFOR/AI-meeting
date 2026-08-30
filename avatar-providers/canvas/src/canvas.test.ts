// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildCharacterDefinition } from "@rcai/avatar-core";
import { createFrame } from "@rcai/audio-core";
import { CanvasAvatarProvider, drawFace } from "./canvasAvatar.js";

const manifest = { id: "dbg", name: "Debug", renderer: "canvas", defaultPersona: "friendly", supportedLanguages: ["ja-JP"], motionProfile: "x", voiceProfiles: [] };

describe("CanvasAvatarProvider", () => {
  it("mounts a canvas, ticks params from the motion stack and closes the mouth on interrupt", async () => {
    let t = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const a = new CanvasAvatarProvider({ container, clock: () => t, scheduler: "manual" });
    await a.prepare(buildCharacterDefinition(manifest, { model: "none", voice: { voices: {} } }, "/x"));
    await a.start();
    expect(container.querySelector("canvas")).not.toBeNull();
    a.setState("SPEAKING");
    const loud = new Float32Array(480);
    for (let i = 0; i < loud.length; i++) loud[i] = 0.5 * Math.sin((2 * Math.PI * 700 * i) / 48000);
    for (let i = 0; i < 20; i++) { a.pushAudio(createFrame(loud, 48000, t)); t += 10; a.tick(t); }
    expect(a.getParams().mouthOpenY).toBeGreaterThan(0.2);
    a.interrupt();
    expect(a.getParams().mouthOpenY).toBe(0);
    await a.stop();
    expect(container.querySelector("canvas")).toBeNull();
  });
  it("drawFace issues canvas commands without throwing on a stub context", () => {
    const calls: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (typeof k === "string" && ["fillStyle", "strokeStyle", "lineWidth", "font", "textAlign", "lineCap"].includes(k) ? undefined : (...args: unknown[]) => { calls.push(String(k)); return args; }), set: () => true }) as unknown as CanvasRenderingContext2D;
    drawFace(ctx, 400, 600, { ...neutral(), mouthOpenY: 0.5 }, { accent: "#000", background: "#fff", name: "n", state: "SPEAKING" });
    expect(calls).toContain("ellipse");
    expect(calls).toContain("fillText");
  });
});

function neutral() {
  return { angleX: 0, angleY: 0, angleZ: 0, bodyAngleX: 0, bodyAngleY: 0, bodyAngleZ: 0, eyeLOpen: 1, eyeROpen: 1, eyeLSmile: 0, eyeRSmile: 0, eyeBallX: 0, eyeBallY: 0, browLY: 0, browRY: 0, browLForm: 0, browRForm: 0, mouthOpenY: 0, mouthForm: 0, cheek: 0, breath: 0, shoulder: 0, armL: 0, armR: 0, handL: 0, handR: 0 };
}
