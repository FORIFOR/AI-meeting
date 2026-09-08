# クラウド移行用の非公開ステージング

段階方針は[クラウド段階移行の判断](../../docs/architecture/cloud-staged-migration.md)を参照する。ここで作るCloud Run相当のWeb/APIは、Hosted Attendeeを呼ぶ会議経路と、Attendeeを使わない1対1経路を分離する。GKEセルフホストは初期構成に含めない。

Web + token-brokerをLinuxコンテナへ移す構成。会話はGeminiへ直接接続し、ローカル音声エージェントを必要としない。Attendeeは接続先を環境変数で指定する（ホスト型または別途構築したセルフホスト）。このComposeだけではAttendee本体を配置しない。

## 起動準備

リポジトリ直下で実行する。

```bash
cp deploy/cloud/.env.example deploy/cloud/.env
chmod 600 deploy/cloud/.env
# .envにAPIキーとMEETING_TOKEN_SECRET（十分に長いランダム値）を設定
# AttendeeのAPIキーと接続先を同じインスタンスの値で揃える
# 必要なキャラクター素材を取得（READMEと各素材の利用条件を参照）
docker compose -f deploy/cloud/compose.yaml config --quiet
docker compose -f deploy/cloud/compose.yaml up -d --build
curl --fail http://127.0.0.1:18080/health
```

公開URLはRECALL_PUBLIC_URL（ブローカー）とRECALL_BOT_PAGE_URL（Web）で指定する。変数名は既存互換のためRECALLだがAttendeeでも使用する。localhostや現PCの一時トンネルURLをクラウド環境へそのままコピーしない。

ポートはサーバーの127.0.0.1:18080だけに公開する。SSH転送で画面を確認できる。APIキー等の秘密はイメージに含めず、brokerだけへ実行時に注入する。Webビルドは同一オリジンをAPI接続先とし、Geminiを既定エンジンにする。既存ブラウザーに保存済み設定がある場合は設定画面で更新する。

## 公開前の未完了事項

- デプロイ先アカウント・リージョン・ドメインの決定。
- Attendee本体の配置、またはホスト型アカウントの準備。既存セルフホスト検証構成は `scripts/reality/attendee-selfhost/`。開発用パッチ・ストレージ・資格情報・ホスト依存設定を本番用に見直す。
- HTTPS ingressと利用者認証・テナント分離。現APIには未認証のトークン発行や会議一覧があるため、0.0.0.0へのポート公開や公開トンネルで迂回しない。
- Botページ・relay・Webhookは機械接続用の既存セッショントークン/署名を維持する。単純な全域Basic認証ではBotも接続できなくなるため、利用者と機械接続を別に認証する。
- Attendee署名必須化、利用量制限、期限切れBot停止、バックアップ・削除・監視。
- セッション/relayはプロセスメモリに存在するため、現段階はbroker 1台。再起動で進行中会議の認証状態が失われる。無条件の複数レプリカ化をしない。
- 実Meet/Zoomで音声往復、遅延、同時接続、60分安定性を測定し、公開ゲートを通す。

`docker compose ... down`では永続データは保持される。`down -v`は保存データを削除するため通常の停止手順には使用しない。

この構成の準備完了は、クラウドへの配置完了やRelease=GOを意味しない。
