/**
 * The voices a person can actually choose from, per provider.
 *
 * A character ships with one voice per provider, which is the right default and the wrong constraint:
 * the same character reads as a different person depending on the voice, and "who am I talking to" is
 * exactly the kind of thing a user should be able to set. Names are the providers' own ids — the list is
 * curated rather than exhaustive, because an unusable list of forty is not a choice either.
 */
export interface VoiceOption {
  /** Provider-native voice id, sent as SessionConfig.voice. */
  id: string;
  label: string;
  /** Rough character of the voice, so the list can be read without listening to all of it. */
  note: string;
}

export const VOICE_OPTIONS: Record<"openai" | "google" | "local", VoiceOption[]> = {
  openai: [
    { id: "marin", label: "Marin", note: "明るく親しみやすい" },
    { id: "cedar", label: "Cedar", note: "落ち着いた低め" },
    { id: "sage", label: "Sage", note: "穏やかで中庸" },
    { id: "coral", label: "Coral", note: "やわらかく丸い" },
    { id: "verse", label: "Verse", note: "表情の幅が広い" },
    { id: "alloy", label: "Alloy", note: "中性的で素直" },
  ],
  google: [
    { id: "Kore", label: "Kore", note: "明るく親しみやすい" },
    { id: "Aoede", label: "Aoede", note: "穏やかで丁寧" },
    { id: "Leda", label: "Leda", note: "落ち着いた低め" },
    { id: "Puck", label: "Puck", note: "軽快で快活" },
    { id: "Zephyr", label: "Zephyr", note: "やわらかく静か" },
  ],
  local: [{ id: "Kyoko", label: "Kyoko", note: "日本語・女性（macOS 標準）" }],
};

/**
 * The local engine speaks with whatever voices this machine has installed, which is not knowable
 * up front — the agent reports them on /health. Identifiers look like
 * "com.apple.voice.compact.ja-JP.Kyoko"; the last segment is the name a person recognises.
 */
export function localVoiceOptions(installed?: string[]): VoiceOption[] {
  if (!installed?.length) return VOICE_OPTIONS.local;
  return installed.map((id) => {
    const name = id.split(".").pop() ?? id;
    return { id, label: name, note: id.includes("premium") ? "高品質" : id.includes("enhanced") ? "拡張" : "標準" };
  });
}

/** The user's choice when they made one, the character's own voice otherwise. */
export function resolveVoice(providerId: "openai" | "google" | "local", characterVoice: string | undefined, chosen?: string): string | undefined {
  if (!chosen) return characterVoice;
  // Local voices are whatever the machine has, so the list here cannot be the authority for them.
  if (providerId === "local") return chosen;
  return VOICE_OPTIONS[providerId].some((v) => v.id === chosen) ? chosen : characterVoice;
}
