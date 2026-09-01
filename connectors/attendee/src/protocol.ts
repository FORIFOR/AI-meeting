/**
 * Attendee's realtime audio wire format, verified against the API docs and the vendor's own example.
 *
 *   Attendee → us:  { bot_id, trigger: "realtime_audio.mixed", data: { chunk, sample_rate, timestamp_ms } }
 *   us → Attendee:  {          trigger: "realtime_audio.bot_output", data: { chunk, sample_rate } }
 *
 * `chunk` is base64 16-bit single-channel PCM. `sample_rate` is 8000, 16000 or 24000 — 24000 is what the
 * local TTS already produces, so the character's voice crosses without resampling.
 */
export const INBOUND_MIXED = "realtime_audio.mixed";
export const INBOUND_PER_PARTICIPANT = "realtime_audio.per_participant";
/** One participant's webcam frame, base64 JPEG. 360p is 2 fps (Attendee derives the rate from the resolution). */
export const INBOUND_VIDEO = "realtime_video.per_participant";
export const OUTBOUND_AUDIO = "realtime_audio.bot_output";

export interface AttendeeAudioMessage {
  bot_id?: string;
  trigger?: string;
  data?: { chunk?: string; sample_rate?: number; timestamp_ms?: number; participant_uuid?: string };
}

export function decodeChunk(b64: string): Int16Array {
  const bin = typeof Buffer !== "undefined" ? Buffer.from(b64, "base64") : Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const bytes = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
  const aligned = bytes.subarray(0, bytes.byteLength - (bytes.byteLength % 2));
  const out = new Int16Array(aligned.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (aligned[i * 2]! | (aligned[i * 2 + 1]! << 8)) << 16 >> 16;
  return out;
}

export function encodeChunk(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    bytes[i * 2] = pcm[i]! & 0xff;
    bytes[i * 2 + 1] = (pcm[i]! >> 8) & 0xff;
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
