export function LiveCostSummary({ counters }: { counters: Record<string, number> }) {
  const priced = counters.pricedTurns ?? 0, unknown = counters.unpricedTurns ?? 0;
  const duration = (key: string) => counters[key] === undefined ? "未取得" : `${Math.floor(counters[key]! / 60)}分${Math.floor(counters[key]! % 60)}秒`;
  return <section className="credit-balance" aria-label="今回のAI利用量">
    <strong className="credit-title">今回のAI利用量</strong>
    <p>{priced ? <>確認できた応答：<strong>{priced}件</strong></> : "使用量を集計中です"}</p>
    <p className="hint">{unknown > 0 ? `未集計の応答が${unknown}件あります。` : "応答の集計が完了しています。"} 料金の具体額は表示していません。</p>
    <details><summary>利用量の内訳</summary>
      <p>AIとの接続：{duration("liveActiveSeconds")} · 送信した音声：{duration("inputAudioSeconds")} · AIの返答音声：{duration("outputAudioSeconds")}</p>
      <p>送信画像：{counters.imageCount ?? "未取得"}枚 · 最大入力コンテキスト：{(counters.contextPeakTokens ?? 0).toLocaleString()}トークン</p>
      <p className="hint">圧縮回数と文字起こしだけのトークン内訳は未取得です。処理中・取得できなかった使用量は含みません。</p></details>
  </section>;
}
