/** Validate only the caption fields consumed by the room; never log the payload. */
export function observerCaption(payload: Record<string, unknown>) {
  if (payload.trigger !== "transcript.update") return null;
  const data = payload.data as Record<string, unknown> | undefined;
  const text = (data?.transcription as Record<string, unknown> | undefined)?.transcript;
  if (typeof text !== "string" || !text.trim() || text.length > 16000 || typeof data?.speaker_uuid !== "string") return null;
  return { trigger: "transcript.update", data: { text, speakerName: typeof data.speaker_name === "string" ? data.speaker_name : null, participantId: data.speaker_uuid, at: typeof data.timestamp_ms === "number" ? data.timestamp_ms : Date.now() } };
}
