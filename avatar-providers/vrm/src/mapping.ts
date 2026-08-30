import type { AvatarParams } from "@rcai/avatar-core";

export interface Euler3 {
  x: number;
  y: number;
  z: number;
}

/** Pure output of the canonical-parameter → VRM mapping (radians, VRM1 normalized bones, +Z facing). */
export interface VRMPose {
  head: Euler3;
  neck: Euler3;
  spine: Euler3;
  chest: Euler3;
  upperChest: Euler3;
  leftShoulder: Euler3;
  rightShoulder: Euler3;
  leftUpperArm: Euler3;
  rightUpperArm: Euler3;
  leftLowerArm: Euler3;
  rightLowerArm: Euler3;
  leftHand: Euler3;
  rightHand: Euler3;
  /** VRM expression preset weights (0..1). */
  expressions: Record<string, number>;
  /** Look-at target offset in model space relative to the head (metres): +x = model's left. */
  lookAt: { x: number; y: number; z: number };
  /** Breath scale applied to the chest (1 = neutral). */
  breathScale: number;
}

const DEG = Math.PI / 180;

/** Resting drop of the upper arms from the T-pose (rad). Larger gestures than Live2D per spec §16. */
export const ARM_REST_RAD = 1.25;
export const ARM_GESTURE_SCALE = 2;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Sign conventions (viewer stands at +Z looking at the model's face):
 * - Live2D angleX > 0 turns the face toward the viewer's right (= model −X) → rotation.y < 0.
 * - Live2D angleY > 0 looks up → rotation.x < 0 (positive X rotation pitches the face down for a +Z-facing model).
 * - Live2D angleZ > 0 tilts the head toward the viewer's right → rotation.z < 0.
 * - eyeBallX > 0 looks to the viewer's right → target x < 0.
 */
export function mapParamsToVRM(p: AvatarParams): VRMPose {
  const head: Euler3 = { x: -p.angleY * DEG * 0.7, y: -p.angleX * DEG * 0.7, z: -p.angleZ * DEG * 0.7 };
  const neck: Euler3 = { x: -p.angleY * DEG * 0.3, y: -p.angleX * DEG * 0.3, z: -p.angleZ * DEG * 0.3 };
  const spine: Euler3 = { x: -p.bodyAngleY * DEG * 0.5, y: -p.bodyAngleX * DEG * 0.5, z: -p.bodyAngleZ * DEG * 0.5 };
  const chest: Euler3 = { x: -p.bodyAngleY * DEG * 0.3, y: -p.bodyAngleX * DEG * 0.3, z: -p.bodyAngleZ * DEG * 0.3 };
  const upperChest: Euler3 = { x: -p.bodyAngleY * DEG * 0.2 - p.breath * 0.02, y: -p.bodyAngleX * DEG * 0.2, z: -p.bodyAngleZ * DEG * 0.2 };

  // Arms: T-pose → rest (dropped), raised by armL/armR (0..1, scaled ×2 and clamped).
  const raiseL = clamp(p.armL * ARM_GESTURE_SCALE, -0.3, 1.2);
  const raiseR = clamp(p.armR * ARM_GESTURE_SCALE, -0.3, 1.2);
  const shoulderLift = clamp(p.shoulder, -1, 1) * 0.15;
  const leftUpperArm: Euler3 = { x: raiseL * 0.15, y: -raiseL * 0.35, z: -(ARM_REST_RAD - raiseL * 0.9) };
  const rightUpperArm: Euler3 = { x: raiseR * 0.15, y: raiseR * 0.35, z: ARM_REST_RAD - raiseR * 0.9 };
  const leftLowerArm: Euler3 = { x: 0, y: -(0.25 + raiseL * 0.9), z: 0 };
  const rightLowerArm: Euler3 = { x: 0, y: 0.25 + raiseR * 0.9, z: 0 };
  const leftShoulder: Euler3 = { x: 0, y: 0, z: shoulderLift };
  const rightShoulder: Euler3 = { x: 0, y: 0, z: -shoulderLift };
  const leftHand: Euler3 = { x: 0, y: 0, z: -clamp(p.handL, -1, 1) * 0.5 };
  const rightHand: Euler3 = { x: 0, y: 0, z: clamp(p.handR, -1, 1) * 0.5 };

  // Expressions
  const open = clamp(p.mouthOpenY, 0, 1);
  const form = clamp(p.mouthForm, -1, 1);
  const wide = Math.max(0, form);
  const narrow = Math.max(0, -form);
  const expressions: Record<string, number> = {
    blinkLeft: clamp(1 - p.eyeLOpen, 0, 1),
    blinkRight: clamp(1 - p.eyeROpen, 0, 1),
    aa: clamp(open * (1 - Math.abs(form) * 0.5), 0, 1),
    ih: clamp(open * wide * 0.8, 0, 1),
    ee: clamp(open * wide * 0.5, 0, 1),
    ou: clamp(open * narrow, 0, 1),
    oh: clamp(open * narrow * 0.5, 0, 1),
    happy: clamp(Math.max((p.eyeLSmile + p.eyeRSmile) / 2, p.cheek * 0.8, wide * 0.6 * (1 - open)), 0, 1),
    sad: clamp(Math.max(0, (p.browLForm + p.browRForm) / 2) * 0.7 + Math.max(0, -form) * 0.3 * (1 - open), 0, 1),
    angry: clamp(Math.max(0, -(p.browLY + p.browRY) / 2) * 0.8 + Math.max(0, -(p.browLForm + p.browRForm) / 2) * 0.4, 0, 1),
    surprised: clamp(Math.max(0, (p.browLY + p.browRY) / 2 - 0.3) * 1.2 + Math.max(0, (p.eyeLOpen + p.eyeROpen) / 2 - 1) * 1.5, 0, 1),
    relaxed: clamp(p.cheek * 0.3, 0, 1),
  };

  return {
    head, neck, spine, chest, upperChest,
    leftShoulder, rightShoulder, leftUpperArm, rightUpperArm, leftLowerArm, rightLowerArm, leftHand, rightHand,
    expressions,
    lookAt: { x: -clamp(p.eyeBallX, -1, 1) * 0.6, y: clamp(p.eyeBallY, -1, 1) * 0.4, z: 1.0 },
    breathScale: 1 + clamp(p.breath, 0, 1) * 0.015,
  };
}
