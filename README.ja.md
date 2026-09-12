# AI-meeting

[![CI](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml/badge.svg)](https://github.com/FORIFOR/AI-meeting/actions/workflows/ci.yml) · [Download beta / ベータ版](https://github.com/FORIFOR/AI-meeting/releases/tag/v0.2.0-beta.1)
**話すうちに、次の一歩。**

面接、英会話、商談を、AIキャラクターを相手に練習できます。自分のペースで話し、途中で止めて言い直す。使うキャラクターとAIの接続先も選べます。

[音声とアバターを試す](https://ai-meeting.web.app/vrm-demo) · [紹介サイト](https://ai-meeting.forifor.chatgpt.site) · [English](README.md)

**音声・アバターのデモはAPIキー不要です。** テスト音や手元の音声ファイルをブラウザーで再生し、VRMキャラクターの口を動かします。AIとの会話には、ローカルAIの起動またはクラウドサービスの設定が必要です。

[![45秒の実録を見る：VRMアバター、Geminiの実応答、会話から記録したタスク](https://ai-meeting.forifor.chatgpt.site/demo-poster.jpg)](https://youtu.be/qLenE6R7-nI)

**[45秒の実録を見る](https://youtu.be/qLenE6R7-nI)** — タスクの追加、割り込み、変更の確認まで。入力はmacOS Kyokoの合成音声、返答は実際のGeminiで、専用の録画レイアウトを使っています。変更提案は台本との一致をスクリプトで確認して反映しています。[録画方法と検証範囲](docs/validation.md)も公開しています。

## できること

- **声に出して練習する。** 面接、英会話、営業、学習、自由会話のシナリオから始められます。
- **途中で止め、話題を変える。** 停止・割り込み後に、前の返答の字幕や身振りが戻るのを防ぎます。
- **自分のキャラクターを使う。** 利用権のあるVRM 0.0/1.0と音声ファイルを読み込めます。デモでは選択したファイルを外部へアップロードしません。
- **AIの接続先を選ぶ。** OpenAI Realtime、Gemini Live、ローカルAIのアダプターを用意しています。OSSビルドはローカル設定で起動し、`strict_local`ではクラウドへの接続を止めます。

公開デモのキャラクターは、別の利用条件を持つpixiv公式VRMサンプルです。Live2DアダプターとYuiの設定も任意連携として保持しています。今回の公開版はアバター・音声デモで、AI会話にはセルフホスト環境で各自の音声AIを設定します。

## デモを起動する

**Node.js 22**とCorepackを使います。対応するNode.jsの最低バージョンは**20.19.0**、pnpmは**10.12.2**に固定しています。

```sh
git clone https://github.com/FORIFOR/AI-meeting.git
cd AI-meeting
corepack enable
corepack prepare pnpm@10.12.2 --activate
corepack pnpm install --frozen-lockfile
corepack pnpm dev:oss
```

**http://localhost:5173/vrm-demo.html** を開き、テスト音を再生するか、手元の音声ファイルを選んでください。`pnpm build:oss`で`apps/web/dist-oss`へ配布用サイトを生成し、含まれる素材とライセンス通知を検査できます。

## AIとの会話を設定する

| 接続先 | 必要なもの |
| --- | --- |
| ローカルAI | ローカルLLM、音声認識、音声合成の起動と、別途入手したモデル。[起動スクリプト](scripts/local-stack.sh)と[エージェント設定](services/agent/src/config.ts)で環境変数を確認できます。同梱のネイティブ音声ヘルパーはmacOS用です。 |
| OpenAI Realtime | 利用できるアカウントと、token brokerに設定した自分のAPIキー。 |
| Gemini Live | 自分のGemini APIキーと`GEMINI_BACKEND=developer`、または別途設定したVertex AIプロジェクト。 |

クラウド接続では、[brokerの設定例](services/token-broker/.env.example)を`services/token-broker/.env`へコピーし、利用する接続先を設定して`pnpm dev`で起動します。同梱モデルを使う場合はアプリでVRoid Bを選び、AIの接続先を指定してください。各サービスの利用可否・料金・データ処理条件が別途適用されます。APIキーはbroker側に置き、フロントエンドのコードやGitへ含めないでください。

Live2Dやクラウドアバターは任意の追加連携です。SDK・素材・認証情報・サービス条件は、標準のVRM配布とは別に扱います。

## 現在の状態と検証

**ベータ版です。** 2026年9月12日に自動テスト1,028件、型検査、OSSビルド監査が合格しました。従来のVRM制約サンプルでは、日本語50文、割り込み20回、60分連続稼働を確認しています。新しいAvatarSample_Bはブラウザー上と45秒の実Gemini録画で確認しました。このモデル単体での60分連続検証は未実施です。

同じ20音声で測った、Live2Dに対するVRMのローカル再生の追加遅延は、各音声の差のp95で**+6.3ms**でした。**AIが返答するまでの時間ではありません。** 人が感じる自然さ、実AIとの60分連続会話、別のMeet/Zoom参加者の端末へ届く音声・映像は、この結果に含みません。会議連携には別途設定と検証が必要です。

検証条件と実Geminiのタスク操作デモは[公開検証記録](docs/validation.md)を参照してください。

## ライセンス

アプリ固有のコードは[Apache-2.0](LICENSE)で公開し、例外は[NOTICE](NOTICE)に記載しています。第三者のコード、モデル、イラスト、サービスにはそれぞれの条件が適用されます。同梱の[VRMサンプル](characters/vroid-b/LICENSE.md)、Live2DのSDK・素材は別ライセンスです。Attendee由来の部分にはElastic License 2.0が適用され、アプリのライセンスでこれらの権利やサービス利用権を付与するものではありません。

## 導入・開発の相談と、開発への参加

シナリオを試す、不具合を報告する、接続先・言語・キャラクターの対応を改善するところから参加できます。[開発への参加方法](CONTRIBUTING.md)と[セキュリティ報告](SECURITY.md)を参照してください。

**有料の導入・カスタマイズ・運用支援**は、[導入・開発の相談](https://github.com/FORIFOR/AI-meeting/issues/new?template=team-pilot.yml)へ。改善したい業務と必要な支援をお知らせください。対応可否・作業範囲・納期・費用を、着手前に個別に確認します。現在のアプリは開発者向けベータ版で、登録だけで使える月額サービスではありません。公開の相談には機密情報を含めないでください。

役に立ったら、GitHubのスターで保存していただけると、他の方にも見つけてもらいやすくなります。
