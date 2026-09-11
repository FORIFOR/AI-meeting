import { useEffect, useRef } from "react";
import type { MeetingUsageReceipt } from "../billing/meetingUsage.js";
import { LiveCostSummary } from "./LiveCostSummary.js";

export function MeetingUsageSummary({ receipt, aiUsage }: { receipt: MeetingUsageReceipt; aiUsage?: Record<string, number> | null }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView?.({ block: "start", behavior: "auto" });
  }, [receipt.endedAt]);
  const minutes = Math.floor(receipt.elapsedMs / 60000), seconds = Math.floor(receipt.elapsedMs / 1000) % 60;
  return <section ref={panel} tabIndex={-1} className="credit-balance meeting-usage-summary" role="status" aria-live="polite" aria-label="今回の会議の利用クレジット">
    <h2 className="credit-title">今回の利用結果</h2>
    <p>会議Botの消費クレジット（概算）</p>
    <p className="meeting-usage-amount">{receipt.credits === null ? "消費量を確認できませんでした" : <><strong>{receipt.credits.toFixed(2)}</strong> クレジット</>}</p>
    <p>利用時間：{minutes}分{seconds}秒</p>
    <p className="hint">会議Bot 1体の利用分です。料金の具体額は表示していません。</p>
    <details>
      <summary>利用量の詳細</summary>
      <p className="hint">1クレジットはBot 1体で約60分。Bot作成から終了確認までをこの画面で計測し、0.01クレジット単位で切り上げています。待機時間を含みます。後処理などにより実際の差引額と異なる場合があります。</p>
      {aiUsage ? <LiveCostSummary counters={aiUsage} /> : <p className="hint">今回のAI利用量は未取得です。</p>}
    </details>
  </section>;
}
