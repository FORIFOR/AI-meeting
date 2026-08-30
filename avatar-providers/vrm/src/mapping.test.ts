import { describe, expect, it } from "vitest";
import { neutralParams } from "@rcai/avatar-core";
import { ARM_REST_RAD, mapParamsToVRM } from "./mapping.js";

describe("mapParamsToVRM", () => {
  it("neutral params give a rested pose, open eyes, closed mouth", () => {
    const pose = mapParamsToVRM(neutralParams());
    expect(pose.head).toEqual({ x: -0, y: -0, z: -0 });
    expect(pose.leftUpperArm.z).toBeCloseTo(-ARM_REST_RAD);
    expect(pose.rightUpperArm.z).toBeCloseTo(ARM_REST_RAD);
    expect(pose.expressions.blinkLeft).toBe(0);
    expect(pose.expressions.aa).toBe(0);
    expect(pose.expressions.happy).toBe(0);
    expect(pose.lookAt).toEqual({ x: -0, y: 0, z: 1 });
  });

  it("uses viewer-relative sign conventions for head and gaze", () => {
    const p = { ...neutralParams(), angleX: 20, angleY: 10, angleZ: 5, eyeBallX: 0.5, eyeBallY: -0.5 };
    const pose = mapParamsToVRM(p);
    expect(pose.head.y).toBeLessThan(0); // face turns to viewer's right = model -X
    expect(pose.head.x).toBeLessThan(0); // looking up pitches back
    expect(pose.head.z).toBeLessThan(0);
    expect(pose.neck.y).toBeCloseTo(pose.head.y * (0.3 / 0.7));
    expect(pose.lookAt.x).toBeLessThan(0);
    expect(pose.lookAt.y).toBeLessThan(0);
  });

  it("derives visemes from opening and form", () => {
    const a = mapParamsToVRM({ ...neutralParams(), mouthOpenY: 0.8, mouthForm: 0 }).expressions;
    expect(a.aa).toBeCloseTo(0.8);
    expect(a.ih).toBe(0);
    expect(a.ou).toBe(0);
    const i = mapParamsToVRM({ ...neutralParams(), mouthOpenY: 0.6, mouthForm: 1 }).expressions;
    expect(i.ih!).toBeGreaterThan(i.aa!);
    expect(i.ou).toBe(0);
    const u = mapParamsToVRM({ ...neutralParams(), mouthOpenY: 0.6, mouthForm: -1 }).expressions;
    expect(u.ou!).toBeGreaterThan(u.aa!);
    expect(u.ih).toBe(0);
    expect(u.oh).toBeCloseTo(u.ou! * 0.5);
  });

  it("maps blink and emotion params to VRM presets", () => {
    const blink = mapParamsToVRM({ ...neutralParams(), eyeLOpen: 0.1, eyeROpen: 1 }).expressions;
    expect(blink.blinkLeft).toBeCloseTo(0.9);
    expect(blink.blinkRight).toBe(0);
    const smile = mapParamsToVRM({ ...neutralParams(), eyeLSmile: 0.8, eyeRSmile: 0.8, cheek: 0.5, mouthForm: 0.7 }).expressions;
    expect(smile.happy).toBeCloseTo(0.8);
    const sad = mapParamsToVRM({ ...neutralParams(), browLForm: 0.6, browRForm: 0.6, mouthForm: -0.6 }).expressions;
    expect(sad.sad).toBeGreaterThan(0.4);
    const serious = mapParamsToVRM({ ...neutralParams(), browLY: -0.35, browRY: -0.35, browLForm: -0.4, browRForm: -0.4 }).expressions;
    expect(serious.angry).toBeGreaterThan(0.3);
    const surprised = mapParamsToVRM({ ...neutralParams(), browLY: 0.8, browRY: 0.8, eyeLOpen: 1.3, eyeROpen: 1.3 }).expressions;
    expect(surprised.surprised).toBeGreaterThan(0.8);
    for (const v of Object.values(surprised)) expect(v).toBeLessThanOrEqual(1);
  });

  it("amplifies arm gestures (×2) and clamps", () => {
    const raised = mapParamsToVRM({ ...neutralParams(), armR: 0.5, armL: 0.9 });
    expect(raised.rightUpperArm.z).toBeCloseTo(ARM_REST_RAD - 1.0 * 0.9);
    expect(raised.leftUpperArm.z).toBeCloseTo(-(ARM_REST_RAD - 1.2 * 0.9)); // clamped at 1.2
    expect(raised.rightLowerArm.y).toBeGreaterThan(0.25);
    const breath = mapParamsToVRM({ ...neutralParams(), breath: 1 });
    expect(breath.breathScale).toBeCloseTo(1.015);
  });
});
