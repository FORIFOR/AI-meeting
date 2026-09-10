import { describe, expect, it } from "vitest";
import { neutralParams } from "@rcai/avatar-core";
import { humanFaceWeights } from "./HumanGLBAvatarProvider.js";

describe('Human GLB facial mapping', () => {
 it('keeps a neutral face closed and eyes open', () => {
  const p=humanFaceWeights(neutralParams());
  expect(p.jawOpen).toBe(0); expect(p.eyeBlinkLeft).toBe(0); expect(p.eyeBlinkRight).toBe(0);
 });
 it('maps independent blinking, speech and gaze with bounded weights', () => {
  const p=humanFaceWeights({...neutralParams(),mouthOpenY:2,eyeLOpen:0,eyeROpen:1,eyeBallX:-0.4});
  expect(p.jawOpen).toBe(1); expect(p.eyeBlinkLeft).toBe(1); expect(p.eyeBlinkRight).toBe(0);
  expect(p.eyeLookOutLeft).toBe(0.4); expect(p.eyeLookInRight).toBe(0.4);
  expect(Object.values(p).every(v=>v>=0&&v<=1)).toBe(true);
 });
});
