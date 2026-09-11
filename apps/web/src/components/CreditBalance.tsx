import { useEffect, useState } from "react";
import { readLedger, summarizeCredits, type CreditLedger } from "../billing/costs.js";

/** Credits granted to a new user. Provider prices and invoices are intentionally not shown here. */
export const INITIAL_CREDITS = 100;

/** A user-facing wallet view. It exposes credits only, never provider pricing or the developer's bill. */
export function CreditBalance({ enabled = true }: { enabled?: boolean }) {
  const [ledger, setLedger] = useState<CreditLedger | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    setLoading(true);
    void fetch("/meeting-credit-usage.json", { cache: "no-store", signal: abort.signal })
      .then(r => r.ok ? r.json() : null)
      .then(b => { if (!abort.signal.aborted) setLedger(readLedger(b)); })
      .catch(() => { if (!abort.signal.aborted) setLedger(null); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [enabled]);
  if (!enabled) return null;
  const totals = ledger ? summarizeCredits(ledger) : null;
  const consumed = totals?.consumedCredits ?? 0;
  const remaining = Math.max(0, INITIAL_CREDITS - consumed);
  const percent = Math.min(100, Math.max(0, (remaining / INITIAL_CREDITS) * 100));
  return <aside className="credit-balance credit-balance--prominent" aria-label="残りのクレジット" aria-busy={loading}>
    <div className="credit-balance__head">
      <div>
        <span className="credit-eyebrow">利用状況</span>
        <h2 className="credit-title">残りのクレジット</h2>
      </div>
      <span className="credit-balance__initial">初期付与 {INITIAL_CREDITS.toFixed(2)}</span>
    </div>
    <div className="credit-balance__amount"><strong>{remaining.toFixed(2)}</strong><span>クレジット</span></div>
    <div className="credit-progress" role="progressbar" aria-label="残りクレジット" aria-valuemin={0} aria-valuemax={INITIAL_CREDITS} aria-valuenow={Number(remaining.toFixed(2))}><span style={{ width: `${percent}%` }} /></div>
    <p className="credit-balance__meta">{totals ? "初期付与分から利用したクレジットを差し引いています。" : loading ? "利用実績を確認しています…" : "利用実績を取得できませんでした。初期付与分を表示しています。"}</p>
    <details className="credit-details"><summary>クレジットについて</summary><p>会話や会議の利用に応じてクレジットを使います。残りの範囲で利用できます。</p></details>
  </aside>;
}
