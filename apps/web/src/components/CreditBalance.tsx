import { CloudCostSummary } from "./CloudCostSummary.js";
import { useEffect, useState } from "react";
import { estimateMeetingCredits, nonNegativeInput, readLedger, summarizeCredits, type CreditLedger } from "../billing/costs.js";

const dollars = (n: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(n);
const yen = (n: number) => new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" }).format(n);
const billingUrl = "https://app.attendee.dev/projects/proj_OfQ0KVhb9lpqNS0h/billing/";
/** Provider ledger snapshot. This is the shared service's cost, never an individual user's wallet or invoice. */
export function CreditBalance({ enabled = true }: { enabled?: boolean }) {
  const [ledger, setLedger] = useState<CreditLedger | null>(null);
  const [loading, setLoading] = useState(true);
  const [rate, setRate] = useState("150");
  const [extra, setExtra] = useState("");
  const [minutes, setMinutes] = useState("30");
  const [bots, setBots] = useState("1");
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
  const fx = nonNegativeInput(rate);
  const validFx = fx !== null && fx > 0 && fx <= 1000 ? fx : null;
  const extraUsd = nonNegativeInput(extra);
  const m = nonNegativeInput(minutes), b = nonNegativeInput(bots);
  const planned = m !== null && b !== null ? estimateMeetingCredits(m, b) : null;
  const price = ledger?.usdPerCredit ?? 0.5;
  return <aside className="credit-balance" aria-label="利用クレジットと費用">
    <strong className="credit-title">利用クレジットと費用</strong>
    {!ledger || !totals ? <p role="status">{loading ? "利用実績を確認しています…" : "利用実績を取得できませんでした。請求画面で確認してください。"}</p> : <>
      <div className="credit-summary">
        <div><span>これまで使った分</span><strong>{totals.consumedCredits.toFixed(2)} <small>クレジット</small></strong><span>会議Bot {totals.botCount}件・テストを含む</span></div>
        <div><span>会議Botの消費額換算</span><strong>{dollars(totals.usageUsd)}</strong><span>{validFx === null ? "円換算レートを確認してください" : `約${yen(totals.usageUsd * validFx)}（1 USD＝${validFx}円で試算）`}</span></div>
        <div><span>確認時の残り</span><strong>{(ledger.balanceCenticredits / 100).toFixed(2)} <small>クレジット</small></strong><span>Bot 1体で約{Math.max(0, Math.floor(ledger.balanceCenticredits * .6))}分の目安</span></div>
      </div>
      <p className="hint">{ledger.scope}。{new Date(ledger.checkedAt).toLocaleString("ja-JP")} 確認。自動更新ではありません。</p>
      <p className="credit-note">無料枠を含む消費量の金額換算です。実際の支払額とは異なり、AI音声・サーバー料金はこの金額に含まれていません。</p>
      <CloudCostSummary />
      <details className="credit-details">
        <summary>内訳・次回の費用を確認</summary>
        <div className="credit-controls">
          <label>円換算レート（1 USDあたり）<input aria-label="円換算レート" type="number" min="0.01" max="1000" step="0.01" value={rate} onChange={e => setRate(e.target.value)} /></label>
          <p className="hint">初期値の150円は試算用の仮レートです。カード明細などのレートに変更できます。税・為替手数料は含みません。</p>
        </div>
        <table className="credit-table"><caption>確認済みの消費内訳</caption><thead><tr><th scope="col">用途</th><th scope="col">消費</th><th scope="col">金額換算</th></tr></thead><tbody>
          {totals.groups.map(g => <tr key={g.label}><th scope="row">{g.label === "Tester" ? "自動テストの相手" : g.label}</th><td>{g.credits.toFixed(2)} cr</td><td>{dollars(g.credits * price)}</td></tr>)}
          <tr><th scope="row">AI音声・サーバー</th><td colSpan={2}>別枠のGoogle Cloud利用額を参照（集計期間が異なります）</td></tr>
        </tbody></table>
        <div className="credit-controls">
          <label>追加するAI・サーバー費用（USD）<input aria-label="追加費用（USD）" type="number" min="0" step="0.01" placeholder="未確認" value={extra} onChange={e => setExtra(e.target.value)} /></label>
          <p className="hint">同じ集計期間の費用を入力してください。Google Cloudの合計にVertex AIが含まれる場合、AI料金を二重に足さないでください。この入力は試算用で保存されません。</p>
          <output aria-live="polite">{extraUsd === null ? "合計費用：追加費用が未入力のため未確定" : `消費額＋入力した追加費用：${dollars(totals.usageUsd + extraUsd)}${validFx === null ? "" : `（約${yen((totals.usageUsd + extraUsd) * validFx)}）`}`}</output>
        </div>
        <div className="credit-controls credit-plan">
          <strong>次回の会議Bot費用</strong>
          <div className="credit-input-row">
            <label>利用時間（分）<input aria-label="利用時間（分）" type="number" min="0" max="1440" value={minutes} onChange={e => setMinutes(e.target.value)} /></label>
            <label>Botの数<input aria-label="Botの数" type="number" min="1" max="100" step="1" value={bots} onChange={e => setBots(e.target.value)} /></label>
          </div>
          <output aria-live="polite">{planned === null ? "時間は0〜1440分、Bot数は1〜100の整数で入力してください。" : `${planned.toFixed(2)}クレジット ≒ ${dollars(planned * price)}${validFx === null ? "" : `（約${yen(planned * price * validFx)}）`}`}</output>
          <p className="hint">人間の参加者数は含めません。Yui＋Testerなら2体です。待機時間などで実際の消費は増えることがあります。AI音声・サーバーは別料金です。</p>
        </div>
        <details><summary>料金の根拠と計算方法</summary>
          <p>Attendeeは1クレジット＝Bot 1体の稼働1時間。標準単価は$0.50で、購入量により$0.40／$0.35の割引があります。表示は標準単価換算です。実績には取引履歴の差引額を使い、次回の試算はBotごとに0.01クレジット単位で切り上げます。</p>
          <p>Gemini Live（Vertex AI）は会議時間ではなくAIの処理量で課金されます。公開単価は100万トークンあたり、文字入力$0.50、音声・映像入力$3、文字出力$2、音声出力$12です。過去のAI処理量が揃っていないため、実績合計には推測で加算していません。</p>
          <p><a href="https://attendee.dev/pricing" target="_blank" rel="noreferrer">Attendee料金表</a> · <a href="https://cloud.google.com/vertex-ai/generative-ai/pricing" target="_blank" rel="noreferrer">Vertex AI料金表</a>（2026年9月9日確認）</p>
        </details>
      </details>
    </>}
    <a href={billingUrl} target="_blank" rel="noreferrer">最新の残高・取引履歴を確認する ↗</a>
  </aside>;
}
