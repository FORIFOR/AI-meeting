import type { Caption } from "../session/useSession.js";

export function Captions({ items }: { items: Caption[] }) {
  return (
    <div className="captions" aria-live="polite">
      {items.map((c) => (
        <div key={c.id} className={`caption caption--${c.role} ${c.final ? "" : "caption--partial"}`}>
          <span className="caption__who">{c.role === "user" ? "You" : "AI"}</span>
          {c.text || "…"}
        </div>
      ))}
    </div>
  );
}
