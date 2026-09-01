# Realtime Character AI Platform
## 実装仕様書 v1.0

**対象:** AI面接練習 / 英会話 / 営業ロープレ / AI家庭教師 / 雑談 / キャリア相談 / 寄り添い（companion）  
**基本思想:** キャラクターと「会話している」体験を最優先する。  
**AI:** OpenAI / Google Gemini / Localを実行時切替可能。  
**Avatar:** Live2Dを主力、VRM 3D、実写Avatarを追加Providerとして提供。

---

# 1. ゴール

ユーザーがアバターを選び、

1. マイクで自然に話す
2. AIが低遅延で理解する
3. 人間らしい日本語で返答する
4. キャラクターが発話内容に合わせて口・顔・目・頭・身体を動かす
5. ユーザーが割り込める
6. AIもユーザーの発話中は自然に聞く
7. 面接/英会話終了後に別Evaluatorが評価する

状態を実現する。

目標体験は、

**「ChatGPT Voice級の会話自然性 × 高品質Live2Dキャラクター × VTuber以上に会話文脈へ反応する自律モーション」**

とする。

---

# 2. システム全体構成

```text
┌──────────────────────────────────────┐
│             Client App               │
│                                      │
│ Camera / Mic / Speaker / Avatar UI   │
└──────────────────┬───────────────────┘
                   │
            MediaTransport
                   │
         ┌─────────┴─────────┐
         │                   │
    LiveKit/WebRTC        Local Bus
      Cloud/Hybrid       Fully Local
         │                   │
         └─────────┬─────────┘
                   ▼
         Conversation Runtime
                   │
         ┌─────────┼─────────┐
         ▼         ▼         ▼
      OpenAI     Gemini     Local
     Provider   Provider   Provider
         │         │         │
         └─────────┼─────────┘
                   ▼
            Unified Events
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
   Speech       Behavior     Evaluator
   Pipeline      Engine       Sidecar
      │            │
      └──────┬─────┘
             ▼
        Avatar Runtime
             │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
 Live2D     VRM     Realistic
                     │
               LiveAvatar/Tavus
```

AIとAvatarを直接接続しない。

必ず、

`Conversation Runtime → Unified Events → Avatar Runtime`

を経由する。

---

# 3. AI Provider仕様

共通インターフェースを定義する。

```ts
interface RealtimeAIProvider {
  id: "openai" | "google" | "local";

  capabilities(): ProviderCapabilities;

  connect(config: SessionConfig): Promise<void>;

  pushAudio(frame: PCMFrame): void;

  pushImage?(image: ImageFrame): void;

  sendText(text: string): Promise<void>;

  interrupt(): Promise<void>;

  updateContext(context: ConversationContext): Promise<void>;

  disconnect(): Promise<void>;

  onEvent(
    callback: (event: ConversationEvent) => void
  ): void;
}
```

### ProviderCapabilities

```ts
interface ProviderCapabilities {
  nativeAudio: boolean;
  vision: boolean;
  toolCalling: boolean;
  realtimeTranscript: boolean;
  interruption: boolean;
  emotionUnderstanding: boolean;
  localOnly: boolean;
}
```

---

# 4. OpenAI Provider

基本経路：

```text
Microphone
   ↓
WebRTC
   ↓
OpenAI Realtime
   ↓
Audio response
   ↓
ConversationEvent.audio
```

Web/モバイルではephemeral credentialをバックエンドから発行する。

API Keyをクライアントに保存してはならない。

出力イベントはProvider固有eventをそのままUIへ渡さず、

```ts
ConversationEvent
```

へ変換する。

例：

```ts
type ConversationEvent =
  | { type: "user_speech_started" }
  | { type: "user_speech_ended" }
  | { type: "user_transcript"; text: string }
  | { type: "assistant_thinking" }
  | { type: "assistant_speech_started" }
  | { type: "assistant_audio"; pcm: ArrayBuffer }
  | { type: "assistant_transcript"; text: string }
  | { type: "assistant_speech_ended" }
  | { type: "interrupted" }
  | { type: "tool_call"; call: ToolCall }
  | { type: "error"; error: Error };
```

---

# 5. Google Gemini Provider

Gemini Live Adapterを実装する。

```text
Client
 ↓
GeminiLiveAdapter
 ↓
WSS
 ↓
Gemini Live
```

16kHz PCM入力などProvider固有formatはAdapter内部で吸収する。

アプリ側はサンプルレートを意識しない。

```ts
audioNormalizer.push(frame)
```

で統一する。

Gemini固有機能：

```text
Barge-in
Proactive Audio
Affective Dialog
Vision
Live transcription
```

はCapabilityとして公開する。

ただしアプリ本体をGemini固有機能へ依存させない。

---

# 6. Local Provider

完全ローカルではクラウドRealtime APIを利用しない。

```text
Mic
 ↓
Local VAD
 ↓
Local STT
 ↓
Local LLM
 ↓
Local TTS
 ↓
Avatar
```

基本構成：

```text
STT
├ sherpa-onnx
├ whisper.cpp
└ 他モデルAdapter

LLM
├ MLX
├ llama.cpp
├ Ollama
└ vLLM

TTS
├ Style-Bert-VITS2 JP系
└ LocalTTS Adapter
```

Style-Bert-VITS2は日本語向けスタイル制御・ローカル推論候補としてA/B検証対象とする。モデルごとの利用条件・ライセンスはCharacter Voice登録時に必須確認する。

LocalProviderには外部送信禁止モードを設ける。

```ts
privacyMode: "strict_local"
```

の場合：

- LiveKit Cloud禁止
- Cloud STT禁止
- Cloud TTS禁止
- Cloud Evaluator禁止
- telemetry本文送信禁止

とする。

---

# 7. Provider Router

ユーザー設定：

```text
AI Engine

○ Auto
● OpenAI
○ Google Gemini
○ Local

Advanced
─────────────────
Conversation   OpenAI
Vision         Gemini
STT            Local
Evaluation     Local
```

Router：

```ts
interface ProviderRouter {
  conversation(): RealtimeAIProvider;
  evaluator(): EvaluationProvider;
  vision(): VisionProvider;
  transcription(): STTProvider;
}
```

Autoモードはポリシー選択式。

```text
Quality First
Privacy First
Low Latency
Low Cost
Offline
```

例：

```text
Privacy First
Conversation → Local
STT          → Local
Evaluation   → Local
Vision       → Local
```

---

# 8. Avatar Runtime

```ts
interface AvatarProvider {
  prepare(character: CharacterDefinition): Promise<void>;

  start(): Promise<void>;

  pushAudio(frame: PCMFrame): void;

  setState(state: AvatarState): void;

  setEmotion(
    emotion: Emotion,
    intensity: number
  ): void;

  performGesture(
    gesture: Gesture,
    intensity: number
  ): void;

  setGaze(target: GazeTarget): void;

  interrupt(): void;

  stop(): Promise<void>;
}
```

実装：

```text
AvatarProvider
├ Live2DAvatarProvider
├ VRMAvatarProvider
├ LiveAvatarProvider
└ TavusAvatarProvider
```

---

# 9. Live2Dを主Avatar Engineとする

Character Pack：

```text
characters/yui/
│
├ character.json
├ model/
│  ├ yui.moc3
│  ├ yui.model3.json
│  ├ yui.physics3.json
│  └ yui.motionsync3.json
│
├ textures/
│
├ expressions/
│  ├ neutral.exp3.json
│  ├ smile.exp3.json
│  ├ laugh.exp3.json
│  ├ serious.exp3.json
│  ├ sad.exp3.json
│  ├ thinking.exp3.json
│  └ surprised.exp3.json
│
├ motions/
│  ├ idle/
│  ├ listening/
│  ├ speaking/
│  ├ thinking/
│  ├ reaction/
│  ├ teaching/
│  └ greeting/
│
└ manifest.json
```

manifest：

```json
{
  "id": "yui",
  "name": "Yui",
  "renderer": "live2d",
  "defaultPersona": "friendly",
  "supportedLanguages": ["ja-JP", "en-US"],
  "motionProfile": "expressive_v1",
  "voiceProfiles": [
    "yui_openai",
    "yui_google",
    "yui_local"
  ]
}
```

---

# 10. Avatar State Machine

必須状態：

```text
IDLE
LISTENING
THINKING
SPEAKING
INTERRUPTED
REACTING
```

基本遷移：

```text
IDLE
 ↓ userSpeechStarted
LISTENING
 ↓ userSpeechEnded
THINKING
 ↓ assistantSpeechStarted
SPEAKING
 ↓ assistantSpeechEnded
IDLE
```

割り込み：

```text
SPEAKING
 ↓ userSpeechStarted
INTERRUPTED
 ↓
LISTENING
```

AI音声が停止したのにAvatarだけ口を動かし続けることを禁止する。

最大停止遅延：

**100ms以内を目標。**

---

# 11. Motion Stack

1つのmotionを単独再生する方式にはしない。

```text
Layer 6 Semantic Gesture
Layer 5 Emotion
Layer 4 Speech Motion
Layer 3 Gaze
Layer 2 Face Micro Motion
Layer 1 Idle / Breathing
```

を合成する。

例：

AI：

「それは、とても良い回答ですね。」

↓

```text
Base:
speaking_soft

Speech:
head_beat_low

Emotion:
smile 0.65

Gesture:
nod_small 0.4

Gaze:
user 1.0

Lip:
MotionSync
```

---

# 12. Motion Library

各主要Characterにつき初期30モーション以上。

### Idle

```text
idle_breathe
idle_soft_sway
idle_look_left
idle_look_right
idle_relaxed
```

### Listening

```text
listen_neutral
listen_small_nod
listen_interested
listen_head_tilt
listen_serious
listen_long_answer
```

### Speaking

```text
speak_calm
speak_soft
speak_energetic
speak_explain
speak_question
speak_serious
```

### Reaction

```text
nod_small
nod_normal
nod_strong
surprised
happy
laugh_soft
concerned
thinking
encourage
```

### Social

```text
greeting
bow
goodbye
celebrate
```

同じmotionの連続再生は禁止。

直近3〜5回のmotion履歴を保持する。

---

# 13. Listening Motionを最重要実装とする

ユーザー発話中にAvatarを停止させない。

Behavior Engineが、

```text
Blink
Tiny Nod
Head Tilt
Gaze Shift
Breathing
Body Sway
```

を確率的に生成する。

例：

```text
0.0s  listening開始
1.8s  blink
3.2s  tiny gaze shift
5.4s  small nod
7.8s  blink
9.3s  head return
```

ランダムではなく、

```text
時間
ユーザー発話量
発話内容
感情
前回motion
```

を入力として選択する。

---

# 14. Lip Sync

Live2D MotionSyncを主経路とする。

```text
AI PCM Audio
     ↓
Audio Tap
     ├─────────────→ Speaker
     │
     ▼
Live2D MotionSync
     ↓
Viseme weights
     ↓
Mouth Parameters
```

重要：

**TTSのtextを口パクへ使用するのではなく、実際に再生するaudioを解析する。**

これによりOpenAI Native Audio、Gemini Native Audio、Local TTSの全てで同じLipSyncが使える。

Cloud AIを切り替えてもAvatar実装は変わらない。

---

# 15. Behavior Engine

二段構成とする。

### Fast Behavior Engine

ローカルルール。

遅延ゼロに近い反応を担当。

```text
speech start
→ speaking posture

question
→ slight eyebrow raise

user starts
→ listening posture

AI interrupted
→ mouth close
→ listening

long user speech
→ occasional nod
```

### Semantic Motion Planner

文章意味が必要なmotionのみ非同期解析。

入力：

```json
{
  "speaker": "assistant",
  "text": "すごく良い視点だと思います。",
  "mode": "english_lesson"
}
```

出力：

```json
{
  "emotion": "warm_positive",
  "emotionIntensity": 0.58,
  "gesture": "small_nod",
  "gestureIntensity": 0.34,
  "energy": 0.45
}
```

Motion Plannerを待って音声再生を遅らせてはならない。

---

# 16. VRM 3D Provider

第二Character Rendererとして実装。

利用する主要機能：

```text
Humanoid
ExpressionManager
LookAt
SpringBone
Animation
```

Web版はthree-vrmを基本とする。

VRMではLive2Dより、

```text
肩
腕
肘
手
腰
全身
```

の大きなジェスチャーを強化する。

VRM runtimeの`expressionManager`、`lookAt`、humanoid bones、spring bonesを利用できる構造とする。

---

# 17. 実写Avatar

実写は追加Provider。

初期実装：

```text
Realistic Avatar
├ HeyGen LiveAvatar
└ Tavus
```

Cloud modeのみ。

```text
Conversation Agent
       ↓ audio
Avatar Worker
       ↓
synchronized
audio + video
       ↓
LiveKit Room
```

実写ProviderではローカルLive2D Motion Engineを使用しない。

実写側の内部LipSync/animationへ任せる。

UI上では、

```text
Realistic
Anime 2D
Anime 3D
```

を同列に扱う。

---

# 18. CharacterとPersonaを分離

重要。

```text
Character ≠ Personality
```

YuiというCharacterを、

```text
Friend
English Teacher
Interviewer
Career Coach
Tutor
Free Talk
```

として使えるようにする。

Persona：

```ts
interface Persona {
  id: string;

  systemPrompt: string;

  language: string;

  speakingStyle: SpeakingStyle;

  turnPolicy: TurnPolicy;

  motionProfile: string;

  evaluationProfile?: string;
}
```

---

# 19. 面接モード

開始画面：

```text
Interview Practice

Position
[ Software Engineer ]

Company style
[ Japanese Large Company ]

Difficulty
[ Standard ]

Interviewer
[ Yui ▼ ]

AI Engine
[ Auto ▼ ]

Start Interview
```

会話中：

```text
┌──────────────────────────┐
│                          │
│       AI Character       │
│                          │
│                          │
│       ● Listening        │
│                          │
│              ┌───────┐   │
│              │ You   │   │
│              └───────┘   │
│                          │
│ 🎤     📷     CC    End │
└──────────────────────────┘
```

採点UIを会話中に表示しない。

---

# 20. 英会話モード

モード：

```text
Free Talk
Travel
Business
Interview
Daily Conversation
Pronunciation
Beginner
```

会話中の訂正を最小化する。

毎文訂正は禁止。

Evaluatorが裏側で記録し、

3〜5ターンまたはセッション終了後にフィードバックする。

---

# 21. Evaluator Sidecar

会話AI自身に採点を担当させない。

```text
Conversation AI
        │
        ├── user transcript
        ├── assistant transcript
        ├── timing
        ├── interruptions
        ├── silence
        └── audio metrics
                  ↓
             Evaluator
```

評価結果：

```json
{
  "overall": 82,
  "clarity": 88,
  "specificity": 74,
  "structure": 85,
  "relevance": 90,
  "fluency": 81,
  "feedback": [],
  "improvedAnswer": ""
}
```

Evaluation Providerも、

```text
OpenAI
Gemini
Local
```

から選択可能。

---

# 22. 日本語会話規則

すべてのProviderへ共通Conversation Policyを適用。

```text
・書き言葉ではなく話し言葉
・原則1〜3文
・不必要に長く話さない
・毎ターン「なるほど」を言わない
・ユーザー発言を毎回要約しない
・過剰な敬語を避ける
・質問は一度に一つを基本
・発話途中に割り込まない
・適度な沈黙を許容
・自然な相槌を使う
・日付/数字/英単語を発話用に正規化
```

Providerごとの差をPrompt Adapterで吸収する。

---

# 23. 音声Normalizer

全Providerで内部audio形式を統一。

内部推奨：

```text
Float32 PCM
48 kHz
mono
```

Provider Adapter境界で変換する。

例：

```text
Internal 48k
  ↓
Gemini adapter
16k PCM input

Gemini output
24k PCM
  ↓
Resampler
48k Internal
```

Avatar MotionSyncには最終再生PCMを渡す。

---

# 24. Voice Profile

キャラクターと音声Providerを分離。

```json
{
  "characterId": "yui",
  "voices": {
    "openai": "voice_x",
    "google": "voice_y",
    "local": "yui_jp_extra"
  }
}
```

Providerを切り替えても、

```text
話す速度
energy
pitch感
敬語レベル
人格
```

を極力維持する。

---

# 25. フォルダ構成

```text
/apps
  /web
  /desktop

/services
  /agent
  /evaluation
  /token-broker

/packages
  /conversation-core
  /provider-core
  /avatar-core
  /behavior-engine
  /audio-core
  /persona-core

/providers
  /openai
  /gemini
  /local

/avatar-providers
  /live2d
  /vrm
  /liveavatar
  /tavus

/characters
  /yui
  /reina
  /haru

/personas
  /interview
  /english
  /sales
  /tutor
```

---

# 26. セキュリティ

Cloud API Keyをクライアントへ保存しない。

利用：

```text
Client
 ↓
Token Broker
 ↓
Ephemeral credential
 ↓
Realtime API
```

保存対象：

```text
Provider
Model
Character
Persona
Session metadata
Transcript
Evaluation
```

音声原本はデフォルト非保存。

録音保存は明示opt-in。

---

# 27. 遅延目標

最重要KPI。

目標：

```text
User speech end
→ AI speech start

P50  < 700ms
P95  < 1500ms
```

割り込み：

```text
User starts speaking
→ AI audio stops

target < 150ms
```

Avatar：

```text
audio
→ lip movement

target < 80ms
```

Listening state：

```text
speech detected
→ avatar listening

target < 100ms
```

---

# 28. Reality Gate

リリース判定はAPI成功ではなく体験で行う。

## Gate A — Conversation

10分連続会話。

必須：

```text
✓ 会話が途切れない
✓ 発話途中に不自然に割り込まない
✓ ユーザー割り込み成功
✓ 日本語が不自然に長文化しない
✓ Provider切替可能
```

## Gate B — Character

10分間観察。

```text
✓ 口だけ動く状態にならない
✓ Listening中に固まらない
✓ 瞬きが機械的でない
✓ 同じnodを連発しない
✓ 頭・目・身体が自然に動く
✓ 発話終了時に口が止まる
```

## Gate C — LipSync

50日本語文章で確認。

```text
✓ あいうえお差
✓ 数字
✓ 英単語混在
✓ 人名
✓ 長文
✓ 早口
✓ 疑問文
```

## Gate D — Provider

同一Personaで、

```text
OpenAI
Google
Local
```

を切り替え、

Character UIを変更せず動作すること。

---

# 29. 実装フェーズ

### Phase 1

Live2D Character 1体。

実装：

```text
Idle
Listening
Thinking
Speaking
Blink
Gaze
Breathing
LipSync
```

OpenAI Realtime接続。

### Phase 2

Gemini Live Provider追加。

OpenAI/Gemini切替UI。

### Phase 3

Local Provider。

```text
Local STT
Local LLM
Local TTS
```

完全オフライン会話。

### Phase 4

Behavior Engine。

```text
Semantic emotion
Gesture Planner
Listening reaction
motion variation
```

### Phase 5

Character Store。

3〜10体。

衣装/背景/Persona選択。

### Phase 6

VRM 3D。

### Phase 7

LiveAvatar/Tavus実写Provider。

### Phase 8

Evaluator。

Interview / English / Sales。

---

# 30. 最初に完成させるべきMVP

最初のReality Gateは以下だけに絞る。

```text
1 Character
       Yui

1 Renderer
       Live2D

3 AI
       OpenAI
       Gemini
       Local

2 Modes
       Free Talk
       Interview

Avatar behavior
       Idle
       Listening
       Thinking
       Speaking
       Blink
       Gaze
       Nod
       Emotion
       LipSync
```

これで、

**「10分話していてAIキャラクターだという違和感が極力少ない」**

ところまで完成させる。

その後Character数を増やす。

---

# 最終アーキテクチャ

```text
                     Application
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
     Interview        English           Free Talk
        │                │                 │
        └────────────────┼─────────────────┘
                         │
                      Persona
                         │
                Conversation Runtime
                         │
        ┌────────────────┼────────────────┐
        │                │                │
     OpenAI            Gemini           Local
        │                │                │
        └────────────────┼────────────────┘
                         │
                   Unified Events
                         │
             ┌───────────┴───────────┐
             │                       │
        Audio Pipeline          Behavior Engine
             │                       │
             │              ┌────────┼────────┐
             │              │        │        │
             │           Emotion  Gesture   Gaze
             │              │        │        │
             └──────────────┴────────┴────────┘
                         │
                    Avatar Runtime
                         │
            ┌────────────┼─────────────┐
            │            │             │
         Live2D         VRM        Realistic
            │            │        LiveAvatar
            │            │          Tavus
            └────────────┴─────────────┘
                         │
                         ▼
                       User
```

**設計上の最重要ルールは「AI・Voice・Avatar・Persona・Evaluationを互いに独立させること」。**

これを守れば、将来さらに高性能なAI、TTS、Live2D技術、実写Avatar Providerが登場しても、アプリ全体を書き直さず交換できる。