# Hosted試験運用 — 採用方針と残作業

合意済み: 通常月5,000円、ハード上限月10,000円、20〜30実会議時間/月。Attendee Hosted + Gemini 3.1 Flash Live + Renderを第一候補にする。最安比較・Attendeeセルフホスト移行は行わない。Attendee時間は「AIを会議の参加者として入れる」場合だけ発生し、1対1のTalk with AIでは発生させない。詳細は[セッションモードの設計](../../docs/architecture/session-modes.md)。

## 今回追加したもの

- `budget-policy.json`: 合意済み予算と構成。Attendee予算はMeeting系のBot時間だけに適用する。
- `pnpm cloud:hosted:preflight`: 専用のHOSTED_ATTENDEE_API_KEYでHostedの読み取り認証だけを確認。ローカルAttendeeのキーは転用しない。Bot作成・会議参加・課金処理は実行しない。
- Gemini `usageMetadata`の数値カウンターをusageイベントとして取り出し、既存のSessionReport/telemetryへ追加。音声本文・会議内容を保存しない。最大256観測と欠落件数を保持。再接続や累積/差分の扱いを請求と照合するまで観測を単純合算しない。
- `pnpm budget:check --ledger <実費台帳.json> --month YYYY-MM --reserve-jpy <次処理の最大見積円>`: 月間実費＋未消化予約＋次の予約を判定。5,000円超はWARN、10,000円超はSTOP。不完全な台帳はBLOCKED。実処理の停止はまだ接続していないため `enforced:false` を返す。

台帳の仕様はschemaVersion=1、currency=JPY、entries配列。各行はid（重複不可）、month（YYYY-MM）、category（fixed/attendee/gemini/infrastructure）、kind（actual/reservation）、jpy（非負の数値）。coverage[月][各category]=trueは、当該項目の請求・予約を照合済みと運用者が確認した場合のみ設定する。固定費はfixed、インフラ従量分はinfrastructureへ入れ、二重計上しない。請求確定した予約は実費へ置換する。台帳は秘密管理対象としてGitへ追加しない。

## 上限制御の必須実装（未完了）

1. 永続台帳へ原子的に費用を予約してからBot作成/AI接続を許可。並行要求、再起動、月またぎにも対応。判定CLIだけでは予約・停止を保証しない。
2. Hostedの最大稼働時間設定とサーバー監視でBotを停止し、退室完了まで確認。停止失敗時は再試行と管理通知。
3. Gemini直接接続にはクライアント申告の利用量だけを信用しない。運営管理下のBot/接続と有効期限・発行枠を紐付け、進行中セッションも止める。発行済みトークンと再接続を含めて検証。
4. 5,000円超過見込みはUIと永続イベントで通知。10,000円を超える見込みの新規処理を拒否し、上限前の余裕を持った停止を行う。停止予告を利用者へ表示する。
5. 税・為替・請求遅延・通信/保存・固定費・別経路のAPI呼び出しを含める。5時間無料は初回だけで、毎月の原価計算に含めない。
6. プロバイダーの予算通知と強制課金停止を区別する。実請求上限は事業者の課金設定も確認し、アプリ推計の上限を請求保証と表現しない。

## 実行順と現在のブロッカー

1. **Attendee Hostedアカウント作成と専用APIキー設定** → 読み取り認証 → voice_agent_settings、音声/映像出力、WebSocket、Webhook署名、最大稼働時間の互換性確認。ローカルのパッチ適用版で動作した事実だけではHosted合格としない。
2. **Renderアカウント作成・支払い設定** → 公開用認証と機械接続の認証を整備 → API/Webを配置。現Composeは非公開検証用。初期見積$7/月は契約画面で確認し、永続ディスクや転送の追加費用も固定/従量費へ記録。
3. **Gemini課金プロジェクト確認** → 専用キー・利用量・課金制限の設定。既存キーの有料状態は未確認。
4. 実Google Meet 5分 → 30分Gate → Zoom → Teams。Teamsは現在disabledのため、専用検証と公開承認を経るまで公開しない。
5. 20〜30実会議時間を集計し、会議時間・Bot時間・送信音声・生成音声・利用トークン・追加API・請求額を照合。二体Bot試験は二体分を計上。
6. 速度・品質基準を満たした実原価で価格と無料枠を決める。今は980/1480/2980円のいずれも確定しない。

## 料金の参照元（2026-09-08確認）

- https://attendee.dev/pricing — 最初の5時間無料、その後$0.50/Bot時間。
- https://ai.google.dev/gemini-api/docs/pricing — モデル別単価。人間が話した時間とAPIへ入力した音声時間は同じとは限らない。
- https://render.com/pricing — 契約前にCompute・永続ディスク・転送の料金を確認。
- https://ai.google.dev/api/live — usageMetadataはサーバー応答に含まれる。ブラウザー報告は請求確定情報ではない。

この文書のTODOは `docs/performance/TODO.md` のP1/P2を具体化する。アカウント作成・Hosted接続・クラウド公開・強制停止・請求照合はまだ完了していない。
