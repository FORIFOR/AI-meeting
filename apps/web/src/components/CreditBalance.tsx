import { useEffect, useState } from "react";

interface Balance { credits: number; checkedAt: string; billingUrl: string }
/** A dated operator-confirmed balance, never an invented live balance or a user wallet. */
export function CreditBalance({ enabled = true }: { enabled?: boolean }) {
  const [balance, setBalance] = useState<Balance | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController();
    void fetch("/meeting-credit-balance.json", { cache: "no-store", signal: abort.signal })
      .then(r => r.ok ? r.json() : null)
      .then((b: Balance | null) => {
        if (b && Number.isFinite(b.credits) && Number.isFinite(Date.parse(b.checkedAt)) && /^https:\/\/app\.attendee\.dev\//.test(b.billingUrl)) setBalance(b);
      }).catch(() => {});
    return () => abort.abort();
  }, [enabled]);
  if (!enabled) return null;
  return <aside className="credit-balance" aria-label="会議のクレジット残高">
    <strong>前回確認した会議残高：{balance ? `${balance.credits.toFixed(2)} クレジット` : "未確認"}</strong>
    {balance && <div>約{Math.max(0, Math.floor(balance.credits))}時間{Math.max(0, Math.floor(balance.credits * 60) % 60)}分相当 · {new Date(balance.checkedAt).toLocaleString("ja-JP")} 確認</div>}
    <div className="hint">サービス共通の会議用残高です。自動更新ではありません。AIとの会話料金は別です。</div>
    <a href={balance?.billingUrl ?? "https://app.attendee.dev/"} target="_blank" rel="noreferrer">最新の残高を確認する ↗</a>
  </aside>;
}
