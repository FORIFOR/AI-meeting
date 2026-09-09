# 2026-09-09 遅延の追加切り分け

公開GOではない。実Meet/ZoomのURLは再チェックでも未設定。15人×3セッションの実回答も未提供。

## 修正

Geminiのmetrics.engines.llmが、brokerで選択された接続先ではなくクライアントの要求モデルを記録していた。connectedModelを記録するよう修正し、brokerが別モデルを返す回帰試験を追加。Geminiの33試験と型検査、production buildが成功。

## 感情表現機能の比較

同じ合成音声を実Geminiへ送り、affective dialogを有効・無効・無効・有効の順で各3回、計12回比較した。results.jsonは修正前プロセスによる診断記録。モデル名は上述の不具合により要求モデルが記録されており、実接続はbrokerのVertex native audio。発話途中の区切り・割り込みが混ざり、多くの行でfirstAudioSentMsが欠測。残った値だけを集計すると選択バイアスになるため、遅延改善の証拠として採用しない。感情表現設定は変更しない。

probe.tsは診断専用で、/tmp/latency-probe.pcmに16kHz mono PCM16音声が必要。今回の発話は「今日は英会話の練習をしたいです。最初の質問をお願いします。」をmacOS Kyokoで生成したもの。人間の評価や実機の音響品質を代替しない。

前回18分試験のp50=1138ms、p95=1676msは前候補の参考値として保持する。今回のソース変更後に計測したことにはしない。

## 本番への反映後

Webを`sites/ai-meeting/versions/bac17295ed47b804`へ反映し、公開index.htmlとローカルproduction buildの一致を確認した。候補buildIdは`18bcaadc814dad9d2d7c720a70c71e5a74331c47fe277ffb1799c65481a56258`。

public-smoke/の本番3分試験は180369ms継続、音声開始25標本でp50=1077ms、p95=1181ms。p50は700msの基準未達で、標本数も公開判定には不足。pageErrors=0、httpErrors=0、toasts=0。一方consoleErrors=21（ERR_CONNECTION_REFUSED）がある。試験は停止中のローカル補助agentを指定しており、その構成の制約を含む。実機音質の合格や全体エラーゼロとは主張しない。

現在のrelease:realityは新候補に対応する公開判定用証拠が不足しBLOCKED（50項目）。旧evidence.jsonのbuildIdは書き換えていない。測定の記録ミス修正は完了したが、遅延改善・実会議試験・15人の利用評価は未完了。
