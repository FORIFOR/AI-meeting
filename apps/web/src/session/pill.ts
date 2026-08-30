import type { AvatarState } from "@rcai/avatar-core";

export interface Pill {
  key: "idle" | "listening" | "thinking" | "speaking" | "interrupted";
  ja: string;
  en: string;
}

/** AvatarRuntime state → status pill (spec §19 "● Listening"). REACTING is presented as its base mood. */
export function pillFor(state: AvatarState, connecting = false): Pill {
  if (connecting) return { key: "thinking", ja: "接続中", en: "Connecting" };
  switch (state) {
    case "LISTENING":
      return { key: "listening", ja: "聞いています", en: "Listening" };
    case "THINKING":
      return { key: "thinking", ja: "考え中", en: "Thinking" };
    case "SPEAKING":
      return { key: "speaking", ja: "話しています", en: "Speaking" };
    case "INTERRUPTED":
      return { key: "interrupted", ja: "中断", en: "Interrupted" };
    case "REACTING":
    case "IDLE":
    default:
      return { key: "idle", ja: "待機中", en: "Idle" };
  }
}
