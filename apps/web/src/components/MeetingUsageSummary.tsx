import type { MeetingUsageReceipt } from "../billing/meetingUsage.js";
export function MeetingUsageSummary({ receipt }: { receipt: MeetingUsageReceipt }) {
  const minutes = Math.floor(receipt.elapsedMs / 60000), seconds = Math.floor(receipt.elapsedMs / 1000) % 60;
  return <section className="credit-balance meeting-usage-summary" role="status" aria-live="polite" aria-label="今回の会議の利用クレジット">
    <strong className="credit-title">今回の会議の利用目安</strong>
    <p className="meeting-usage-amount">{receipt.credits === null ? "消費量を計算できませんでした" : <>約 <strong>{receipt.credits.toFixed(2)}</strong> クレジット</>}</p>
    <p>この画面での計測：{minutes}分{seconds}秒 · 会議Bot 1体</p>
    {receipt.credits !== null && <p>標準単価で約 ${(receipt.credits * .5).toFixed(3)} 相当</p>}
    <p className="hint">確定額ではありません。Bot作成後から終了・退出操作までの時間による概算です。待機や後処理などで実際の差引額と異なる場合があります。AI音声・サーバー料金は含みません。</p>
    <a href="https://app.attendee.dev/projects/proj_OfQ0KVhb9lpqNS0h/billing/" target="_blank" rel="noreferrer">確定した消費量を取引履歴で確認 ↗</a>
  </section>;
}
