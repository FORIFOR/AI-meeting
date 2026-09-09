import { useEffect, useState } from "react";
export interface CloudCosts { checkedAt: string; periodStart: string; periodEnd: string; currency: "JPY"; gross: number; savings: number; net: number; services: { name: string; gross: number; savings: number; net: number }[] }
export function readCloudCosts(raw: unknown): CloudCosts | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as CloudCosts;
  const valid = (r: { gross: number; savings: number; net: number }) => [r.gross,r.savings,r.net].every(x=>Number.isSafeInteger(x)&&x>=0) && r.gross-r.savings===r.net;
  if (d.currency!=="JPY" || !Number.isFinite(Date.parse(d.checkedAt)) || !/^\d{4}-\d{2}-\d{2}$/.test(d.periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(d.periodEnd) || d.periodStart>d.periodEnd || !valid(d) || !Array.isArray(d.services) || d.services.some(r=>!r||typeof r.name!=="string"||!valid(r))) return null;
  return ["gross","savings","net"].every(k=>d.services.reduce((s,r)=>s+r[k as "net"],0)===d[k as "net"]) ? d : null;
}
const yen=(n:number)=>new Intl.NumberFormat("ja-JP",{style:"currency",currency:"JPY"}).format(n);
export function CloudCostSummary() {
  const [cost,setCost]=useState<CloudCosts|null>(null);
  useEffect(()=>{const a=new AbortController();void fetch("/cloud-costs.json",{cache:"no-store",signal:a.signal}).then(r=>r.ok?r.json():null).then(d=>{if(!a.signal.aborted)setCost(readCloudCosts(d));}).catch(()=>{});return()=>a.abort();},[]);
  return <section className="credit-controls" aria-label="Google Cloudの利用額">
    <strong>AI・サーバー費用（Google Cloud）</strong>
    {!cost ? <p>確認済みの請求データを取得できませんでした。</p> : <>
      <p><strong>{yen(cost.net)}</strong>（割引後・税額未計上） · {cost.periodStart}〜{cost.periodEnd}</p>
      <p className="hint">請求レポートに反映済みの利用額です。月末の確定請求・支払済み額ではありません。会議Botとは期間が異なるため、合計していません。</p>
      <details><summary>AI・サーバー費用の内訳</summary>
        <table className="credit-table"><thead><tr><th>サービス</th><th>割引前</th><th>割引</th><th>割引後</th></tr></thead><tbody>{cost.services.map(r=><tr key={r.name}><th scope="row">{r.name}</th><td>{yen(r.gross)}</td><td>−{yen(r.savings)}</td><td>{yen(r.net)}</td></tr>)}</tbody></table>
        <p>割引前 {yen(cost.gross)} − 割引 {yen(cost.savings)} ＝ {yen(cost.net)}</p>
        <p className="hint">{new Date(cost.checkedAt).toLocaleString("ja-JP")} 確認。円建ての表示額を記録しています。期間後の利用は含まず、自動更新ではありません。</p>
      </details>
    </>}
  </section>;
}
