import type { ToastMsg } from "../session/useSession.js";

export function Toasts({ items }: { items: ToastMsg[] }) {
  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.code && <span className="toast__code">{t.code}</span>}
          {t.message}
        </div>
      ))}
    </div>
  );
}
