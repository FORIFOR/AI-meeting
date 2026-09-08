import type { Caption } from "../session/useSession.js";

/**
 * What is being said right now — not a transcript. The assistant's latest line,
 * and the user's line only while it is still being recognised.
 */
export function Subtitle({ items, on }: { items: Caption[]; on: boolean }) {
  if (!on) return null;
  const assistant = [...items].reverse().find((c) => c.role === "assistant" && c.text);
  const user = [...items].reverse().find((c) => c.role === "user" && c.text);
  const userIsLatest = user && assistant ? items.indexOf(user) > items.indexOf(assistant) : !!user;
  return (
    <div className="subtitle" aria-live="polite">
      {userIsLatest && user && !user.final && (
        <p className={`subtitle__line subtitle__line--user subtitle__line--partial`}>{user.text}</p>
      )}
      {assistant && (
        <p key={assistant.id} className={`subtitle__line ${assistant.final ? "" : "subtitle__line--partial"}`}>
          {assistant.text}
        </p>
      )}
    </div>
  );
}

/**
 * The conversation as text, off-screen. Visible UI shows only the latest line, but a live
 * transcript belongs in the accessibility tree — and the Reality-Gate runners read it too.
 */
export function TranscriptLog({ items }: { items: Caption[] }) {
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="false">
      {items.map((c) => (
        <p key={c.id} data-caption-id={c.id} className={`caption caption--${c.role} ${c.final ? "" : "caption--partial"}`}>
          <span className="caption__who">{c.role === "user" ? "You" : "AI"}</span>
          {c.text}
        </p>
      ))}
    </div>
  );
}

/** The full list, used on the meeting screen where reading back matters. */
export function CaptionList({ items }: { items: { id: number; role: string; text: string; final: boolean; who?: string }[] }) {
  return (
    <div className="captions--list">
      {items.map((c) => (
        <div key={c.id} className={`caption caption--${c.role}`}>
          <span className="caption__who">{c.who ?? (c.role === "user" ? "あなた" : "AI")}</span>
          {c.text || "…"}
        </div>
      ))}
    </div>
  );
}
