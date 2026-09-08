# 2026-09-09 遅延の追加切り分け

公開GOではない。実Meet/ZoomのURLは再チェックでも未設定。15人×3セッションの実回答も未提供。

## 修正

Geminiのmetrics.engines.llmが、brokerで選択された接続先ではなくクライアントの要求モデルを記録していた。connectedModelを記録するよう修正し、brokerが別モデルを返す回帰試験を追加。Geminiの33試験と型検査、production buildが成功。

## 感情表現機能の比較

同じ合成音声を実Geminiへ送り、affective dialogを有効・無効・無効・有効の順で各3回、計12回比較した。results.jsonは修正前プロセスによる診断記録。モデル名は上述の不具合により要求モデルが記録されており、実接続はbrokerのVertex native audio。発話途中の区切り・割り込みが混ざり、多くの行でfirstAudioSentMsが欠測。残った値だけを集計すると選択バイアスになるため、遅延改善の証拠として採用しない。感情表現設定は変更しない。

probe.tsは診断専用で、/tmp/latency-probe.pcmに16kHz mono PCM16音声が必要。今回の発話は「今日は英会話の練習をしたいです。最初の質問をお願いします。」をmacOS Kyokoで生成したもの。人間の評価や実機の音響品質を代替しない。

前回18分試験のp50=1138ms、p95=1676msは前候補の参考値として保持する。今回のソース変更後に計測したことにはしない。
