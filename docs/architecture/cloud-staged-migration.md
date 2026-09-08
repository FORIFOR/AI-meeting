# クラウド段階移行の判断

貼り付けられたGCP中心の案を、現在の予算と実装状態に合わせて段階化する。

## 採用する第一段階

```text
Browser ──短寿命Gemini token──> Gemini Live
   │
   └──同一オリジンAPI──> Cloud Run（token、認証、会議作成、usage）

Meet/Zoomの参加を選んだ場合だけ:
Cloud Run ──meeting_url──> Attendee Hosted ──> meeting
```

Talk with AIはAttendeeを使わない。音声はブラウザーからGeminiへ直接流し、APIは短寿命tokenだけを発行する。会議参加はHosted Attendeeの`meeting_url`と双方向音声経路を使う。現在のAI-meetingにはこの二つのプロバイダー経路が既にある。

第一段階でGKE、Cloud SQL、Memorystore、録画保存を必須にしない。会議履歴・ユーザー同期を要件にしない試験では、Cloud Runの単一インスタンス＋期限付きローカルデータでも検証できる。ただし、公開サービスでの永続化や複数インスタンス化の前にはDBと認証を追加する。

## 後段階（利用量が固定費を正当化したとき）

Hosted AttendeeのBot時間、Cloud Run、Gemini、保存・転送を実請求と照合する。セルフホストで節約できる利用量が、GKEクラスタ、Postgres、Redis、監視、運用の固定費を上回る場合だけAttendeeをGKEへ移す。

その場合も、Botごとに分離したPod（1 Bot = 1 Pod）を使い、共有Celery workerへ複数会議を混在させない。Chromium、音声デバイス、仮想ディスプレイを含む実Meet/Zoomで負荷と音声混入を検証してから本番化する。

## Voice Agentページの扱い

Attendeeの`voice_agent_settings.url`で、現在のアバター・GeminiランタイムをBot内のブラウザーへ載せる方向を検証する。ただし、Hosted版の音声I/O、映像出力、署名Webhook、セッションtokenの有効期限は未検証である。現行のRelay経路を削除せず、同一会議で比較できるまで保持する。

runtime URLにはAPIキーを含めず、一回限りの署名付きセッションtokenだけを渡す。token交換と会議セッション作成はCloud Runで認証する。

## コストゲート

- 通常予算: 月5,000円
- ハード上限: 月10,000円
- 1対1のAttendee費: 0円
- 会議参加のAttendee費: Bot時間として計上
- Gemini、Render/Cloud Run、転送・保存を別カテゴリで計上
- GKE移行: 実請求と同時接続数の測定後に判断

GKEのクラスタ管理、Cloud SQL、Redisを先に契約しない。無料枠・クレジットは継続利用できる予算として扱わず、請求画面の定価と実測で判断する。

## リリース順

1. Cloud Run相当の公開APIで1対1のGemini Liveを実測。
2. Hosted Attendeeを専用APIキーで接続し、Google Meetの5分・30分試験を実施。
3. 同じ`agent/runtime`をBotページとして読み込ませ、音声・映像・退出・Webhookを検証。
4. Zoomを検証。Teamsは現在disabledのため別承認まで公開しない。
5. 20〜30会議時間の実費を照合し、固定費とBot時間を比較。
6. セルフホストGKEの原価が有利になった場合だけ、1 Bot = 1 Podの移行試験を開始。

この段階移行は、[セッションモード設計](./session-modes.md)、[Hosted試験運用](../../deploy/cloud/hosted-pilot.md)、[性能TODO](../performance/TODO.md)と整合する。
