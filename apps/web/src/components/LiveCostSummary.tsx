export function LiveCostSummary({ counters }: { counters: Record<string, number> }) {
  const priced = counters.pricedTurns ?? 0, unknown = counters.unpricedTurns ?? 0;
  const duration = (key: string) => counters[key] === undefined ? "未取得" : `${Math.floor(counters[key]! / 60)}分${Math.floor(counters[key]! % 60)}秒`;
  return <section className="credit-balance" aria-label="今回のAI利用料金">
    <strong className="credit-title">今回のAI音声の料金目安</strong>
    <p>{priced ? <>約 <strong>${((counters.estimatedMicroUsd ?? 0) / 1000000).toFixed(4)}</strong></> : "使用量を集計中です"}</p>
    <p className="hint">単価を確認できた{priced}応答分。{unknown > 0 ? `未計算の応答が${unknown}件あります。` : ""}会議Bot・サーバー料金は別です。</p>
    <details><summary>計算の内訳</summary>
      <p>AIとの接続：{duration("liveActiveSeconds")} · 送信した音声：{duration("inputAudioSeconds")} · AIの返答音声：{duration("outputAudioSeconds")}</p>
      <p>送信画像：{counters.imageCount ?? "未取得"}枚 · 最大入力コンテキスト：{(counters.contextPeakTokens ?? 0).toLocaleString()}トークン</p>
      <p className="hint">圧縮回数と文字起こしだけのトークン内訳は未取得です。Gemini 2.5 Flash Liveの公開単価×応答ごとの使用量。割引・税・為替換算前の概算です。処理中・取得できなかった使用量は含みません。</p><a href="https://cloud.google.com/vertex-ai/generative-ai/pricing" target="_blank" rel="noreferrer">Googleの公開単価 ↗</a></details>
  </section>;
}
