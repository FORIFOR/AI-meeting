/**
 * Local bus wire protocol v2 (docs/integration-contracts.md → services/agent WS /session).
 * Binary server→client: [uint32 LE sampleRate][uint32 LE generationId][uint32 LE sequence][Int16 LE PCM mono]
 * Binary client→server: Int16 LE PCM mono @ 16 kHz
 * Every assistant-side JSON message carries `gen: { turnId, generationId, sequence }` (Round 3 Gate 1):
 * a client drops anything whose generationId is older than the generation it accepted after an interrupt.
 */
export const AGENT_INPUT_RATE = 16_000;
export const PROTOCOL_VERSION = 2;
export const AUDIO_HEADER_BYTES = 12;

export interface WireGen {
  turnId: number;
  generationId: number;
  sequence: number;
}

export function encodeAudioFrame(sampleRate: number, pcm16: Int16Array, gen: { generationId: number; sequence: number } = { generationId: 0, sequence: 0 }): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_BYTES + pcm16.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, sampleRate, true);
  view.setUint32(4, gen.generationId >>> 0, true);
  view.setUint32(8, gen.sequence >>> 0, true);
  out.set(new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength), AUDIO_HEADER_BYTES);
  return out;
}

export function decodeAudioFrame(bytes: Uint8Array): { sampleRate: number; pcm16: Int16Array; generationId: number; sequence: number } {
  if (bytes.byteLength < AUDIO_HEADER_BYTES) throw new Error("audio frame too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sampleRate = view.getUint32(0, true);
  const generationId = view.getUint32(4, true);
  const sequence = view.getUint32(8, true);
  const body = bytes.subarray(AUDIO_HEADER_BYTES);
  const aligned = new Uint8Array(body.byteLength - (body.byteLength % 2));
  aligned.set(body.subarray(0, aligned.length));
  return { sampleRate, pcm16: new Int16Array(aligned.buffer), generationId, sequence };
}

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
  const aligned = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2));
  aligned.set(bytes.subarray(0, aligned.length));
  const i16 = new Int16Array(aligned.buffer);
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = (i16[i] ?? 0) / 0x8000;
  return out;
}

export function float32ToPcm16(data: Float32Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export type ClientMessage =
  | { type: "start"; config: import("@rcai/conversation-core").SessionConfig }
  | { type: "text"; text: string }
  | { type: "interrupt" }
  | { type: "update_context"; context: import("@rcai/conversation-core").ConversationContext }
  | { type: "stop" };

export type ServerMessage =
  | { type: "ready"; stt: string; llm: string; tts: string; protocolVersion?: number }
  | { type: "user_speech_started" }
  | { type: "user_speech_ended" }
  | { type: "user_transcript"; text: string; final: boolean; id?: number }
  /** Second-pass reading of utterance `id`, after its `user_transcript` already went out (LOCAL_STT_FINAL=whisper-async). */
  | { type: "user_transcript_revised"; id: number; text: string }
  | { type: "assistant_thinking"; gen?: WireGen }
  | { type: "assistant_speech_started"; gen?: WireGen }
  | { type: "assistant_transcript"; text: string; final: boolean; gen?: WireGen }
  | { type: "assistant_speech_ended"; gen?: WireGen }
  /** `gen` = the generation that was cancelled. */
  | { type: "interrupted"; gen?: WireGen }
  | { type: "metrics"; turn: import("@rcai/conversation-core").TurnMetrics; gen?: WireGen }
  | { type: "error"; message: string };
