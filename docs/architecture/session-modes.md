# セッションモードとAttendeeの利用範囲

AI-meetingは、会議へBotを参加させる処理と、ユーザーがAIと直接話す処理を分離する。

## Talk with AI

ユーザーがAI-meetingを開いて話す通常の1対1セッション。ブラウザーのマイク・スピーカーとGemini Liveを接続し、会議プロバイダーへBotを作成しない。Attendeeの時間課金は発生しない。応答遅延も会議Botの中継を含まないため、最初にこのモードで速度・品質を検証する。

対象は雑談、英会話、面接練習、相談、TODO整理、アイデア整理など。ここでユーザーへMeeting URLの入力を要求しない。

## Bring AI into a meeting

ユーザーがMeet、Zoom、TeamsのURLを指定し、AIを会議の参加者として入れるセッション。token-brokerがAttendeeへ`meeting_url`を渡し、音声を双方向Relayで接続する。アバター映像を会議へ出す場合はAttendeeのVoice Agentページも使用する。会議Botが作成された時点からAttendee時間が発生するため、退出確認と最大稼働時間を必須にする。

## Meeting assistant

複数人会議の発言、決定、懸念、担当者を扱うセッション。会議へAIを置くにはBring AI into a meetingと同じAttendee経路が必要。会議へ参加せず、ユーザーPCのマイクだけを扱う補助機能はTalk with AIとして扱う。

## 原価の扱い

Geminiは両モードで利用する。AttendeeのBot時間はMeeting系だけに計上する。1対1でAttendeeを呼び出すフォールバックを追加しない。会議ゲートの検証でlistenerとcharacterの2体を作る場合、Bot時間は2体分として集計する。

## 境界と未完了

- 現在のコードには1対1のプロバイダー経路とAttendeeの会議経路が存在するが、UIのモード選択文言はこの分類に合わせた再確認が必要。
- Hosted Attendeeの互換性、公開認証、予算の原子的な予約、稼働中セッションの強制停止は未完了。
- 会議URLだけでは会議参加を実現できない。Botの参加・音声I/O・退出・Webhook検証を経た実Meet/Zoom試験が必要。
