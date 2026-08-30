import type { PCMFrame } from "@rcai/audio-core";
import type { ProviderId } from "@rcai/conversation-core";

/**
 * Streaming STT contract (Round 3, Gate 3).
 * Recognition runs while the user is still speaking; consumers receive partial text, a stable
 * prefix that will not change any more, and the final transcript. Engine specifics never cross
 * this boundary (the Conversation Runtime only sees ConversationEvents).
 */
export type TranscriptKind = "partial" | "stable" | "final";

export interface StreamingTranscript {
  text: string;
  kind: TranscriptKind;
  /** Utterance-relative timing in ms when the engine provides it. */
  startMs?: number;
  endMs?: number;
  confidence?: number;
  /** True when the final text was served from a fresh partial (no extra decode after speech end). */
  reused?: boolean;
}

export interface StreamingSTTCapabilities {
  /** The engine decodes incrementally (true streaming or incremental re-decode). */
  streaming: boolean;
  /** The engine can mark a prefix that will not change. */
  stablePrefix: boolean;
}

export interface StreamingSTTProvider {
  id: ProviderId | string;
  capabilities(): StreamingSTTCapabilities;
  start(opts: { language: string }): Promise<void>;
  /** Internal 48 kHz frames; the adapter converts to its own rate. */
  pushAudio(frame: PCMFrame): void;
  onTranscript(cb: (t: StreamingTranscript) => void): void;
  /** End of utterance: resolves the final transcript (may reuse the last fresh partial). */
  endUtterance(): Promise<StreamingTranscript>;
  /** Drop the current utterance without producing a final. */
  reset(): void;
  stop(): Promise<void>;
}

/** Longest common prefix of two transcripts (what has not changed between decodes). */
export function commonPrefix(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return a.slice(0, i);
}
