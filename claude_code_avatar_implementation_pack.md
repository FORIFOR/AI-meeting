# Claude Code Implementation Pack — Realtime Character AI

Updated: 2026-08-30

## 0. Purpose

Build a provider-independent realtime character conversation platform with:

- AI providers: OpenAI / Google Gemini / Local
- Avatar providers: Live2D (primary) / VRM / Realistic cloud avatar
- Use cases: interview practice / English conversation / free talk
- Low-latency barge-in, Japanese conversation, listening motion, lip sync
- Evaluation sidecar independent from the conversation model

The product code must not be tightly coupled to any single provider.

---

## 1. Official source manifest

### Live2D — manual download required

Cubism SDK for Native:
https://www.live2d.com/en/sdk/download/native/

Cubism SDK MotionSync Plugin:
https://www.live2d.com/en/sdk/download/motionsync/

Native manual:
https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-for-native/

MotionSync manual:
https://docs.live2d.com/en/cubism-sdk-manual/cubism-sdk-motionsync-plugin-for-native/

MotionSync scene integration:
https://docs.live2d.com/en/cubism-sdk-manual/use-on-scene-motion-sync-native/

MotionSync settings:
https://docs.live2d.com/en/cubism-sdk-manual/motion-sync-setting-native/

GitHub framework:
https://github.com/Live2D/CubismNativeFramework

GitHub samples:
https://github.com/Live2D/CubismNativeSamples

GitHub MotionSync components:
https://github.com/Live2D/CubismNativeMotionSyncComponents

IMPORTANT:
Cubism Core and MotionSync Core are NOT fully provided by GitHub.
Do not claim the Live2D runtime works if only the GitHub repositories are present.
The official downloaded packages must be supplied by the developer.

### Realtime transport / agent framework

LiveKit Agents:
https://github.com/livekit/agents

LiveKit Agents docs:
https://docs.livekit.io/agents/

Coding-agent support:
https://docs.livekit.io/intro/coding-agents/

LiveKit Docs MCP:
https://docs.livekit.io/mcp

Install in Claude Code:
claude mcp add --transport http livekit-docs https://docs.livekit.io/mcp

Install LiveKit agent skill:
npx skills add livekit/agent-skills --skill livekit-agents

### Local speech / AI

sherpa-onnx:
https://github.com/k2-fsa/sherpa-onnx

Silero VAD:
https://github.com/snakers4/silero-vad

llama.cpp:
https://github.com/ggml-org/llama.cpp

MLX-LM:
https://github.com/ml-explore/mlx-lm

Style-Bert-VITS2:
https://github.com/yonenn/Style-Bert-VITS2

### 3D avatar references

three-vrm:
https://github.com/pixiv/three-vrm

ChatVRM (REFERENCE ONLY; archived):
https://github.com/pixiv/ChatVRM

Do not base production architecture on ChatVRM. Use it only to study VRM rendering, animation, facial expression, and conversational avatar integration.

---

## 2. Recommended workspace layout

project/
  CLAUDE.md
  docs/
    architecture.md
    acceptance-gates.md
    source-manifest.md
  apps/
    desktop/
    web/
  packages/
    conversation-core/
    provider-core/
    avatar-core/
    audio-core/
    behavior-engine/
    persona-core/
  providers/
    openai/
    gemini/
    local/
  avatar-providers/
    live2d/
    vrm/
    realistic/
  services/
    agent/
    evaluation/
    token-broker/
  characters/
    sample/
  reference/
    ChatVRM/
    livekit-agents/
    three-vrm/
  vendor/
    live2d/
      README_REQUIRED_FILES.md

Never commit API keys, secrets, downloaded proprietary SDK files, or licensed character assets unless their license explicitly permits repository redistribution.

---

## 3. CLAUDE.md rules

1. Read docs/source-manifest.md and docs/architecture.md before modifying architecture.
2. Never bind UI code directly to OpenAI, Gemini, llama.cpp, Live2D, or a specific avatar vendor.
3. All conversational providers must implement the shared RealtimeAIProvider interface.
4. All avatar implementations must implement AvatarProvider.
5. Realtime provider-specific events must be translated into ConversationEvent.
6. Avatar state is driven only by normalized events: IDLE, LISTENING, THINKING, SPEAKING, INTERRUPTED, REACTING.
7. Audio actually sent to the speaker is the source of truth for lip sync.
8. User speech must stop assistant audio and speaking animation immediately.
9. Listening animation must continue while the user talks; never freeze the avatar.
10. Semantic motion planning must never block audio playback.
11. Evaluator must be a separate sidecar and never be required for conversation latency.
12. Local privacy mode must perform no cloud transmission.
13. Do not silently fake integrations. If credentials, proprietary SDK files, models, or assets are missing, create a clear BLOCKED_BY_* gate.
14. Use tests and observable evidence for every completion claim.
15. Preserve existing product behavior unless the goal explicitly changes it.

---

## 4. Implementation order

### Gate 0 — repository audit
- Detect existing languages, UI framework, audio stack, provider clients, avatar code, tests.
- Reuse working code rather than rebuilding.
- Produce docs/current-state.md and gap analysis.

### Gate 1 — contracts
Implement:
- RealtimeAIProvider
- ProviderCapabilities
- ProviderRouter
- ConversationEvent
- AvatarProvider
- AvatarState
- Persona
- EvaluationProvider

Unit-test contracts before provider work.

### Gate 2 — Live2D local character
Render one sample character.
Implement:
- idle
- breathing
- blink
- gaze
- listening
- speaking
- interruption
- expression
- audio-driven MotionSync

If Cubism Core or MotionSync Core is unavailable:
- finish all adapters/build wiring possible
- mark BLOCKED_BY_LIVE2D_CORE
- do not substitute an unrelated fake renderer as PASS.

### Gate 3 — OpenAI realtime adapter
Implement actual realtime audio streaming, interruption and transcript normalization.

### Gate 4 — Gemini Live adapter
Implement the same normalized interface.
Switch providers without changing UI/avatar code.

### Gate 5 — Local adapter
Use local VAD/STT/LLM/TTS adapters.
Support strict_local mode with zero network calls.

### Gate 6 — behavior engine
Blend:
- base state motion
- blink/breathing
- gaze
- speech motion
- emotion
- semantic gestures
Avoid repetitive gestures.

### Gate 7 — personas / products
Add:
- free talk
- interview
- English practice
Do not show scoring during the live conversation.

### Gate 8 — evaluator sidecar
Capture transcript/timing/interruption/fluency metrics and evaluate after or asynchronously during the session.

### Gate 9 — VRM and realistic avatar adapters
VRM via three-vrm where appropriate.
Realistic avatar remains a separate cloud AvatarProvider.

---

## 5. Reality gates

### Conversation
- 10 minute session survives
- natural Japanese
- no frequent premature turn interruption
- user barge-in works
- provider can switch without UI rewrite

### Avatar
- does not freeze while listening
- mouth stops immediately on interruption
- blinking is non-mechanical
- gaze and head motion are subtle
- same gesture does not repeat constantly

### Latency targets
- user end -> assistant audio P50 < 700 ms where provider/network permits
- barge-in -> assistant audio stop target < 150 ms
- audio -> lip response target < 80 ms
- speech detection -> LISTENING target < 100 ms

### Privacy
strict_local:
- no OpenAI
- no Google
- no LiveKit Cloud
- no cloud telemetry containing user content

---

## 6. Claude Code execution policy

Before coding:
1. Inspect the full repository.
2. Run current tests.
3. Record the current passing baseline.
4. Read official docs through LiveKit MCP where applicable.
5. Inspect reference repositories, but do not blindly copy their architecture.
6. Produce a small implementation plan tied to files and gates.
7. Then implement autonomously.

During implementation:
- run tests after each gate
- fix failures before advancing
- keep changes buildable
- never report PASS without executing verification

At completion:
- run full unit/integration/UI tests available in the repo
- provide changed files
- provide commands run
- provide actual results
- list any BLOCKED_BY_* items
- state exactly which Reality Gates pass

---

## 7. First Claude Code goal

Implement the realtime character AI foundation described in this repository. Start with an audit, preserve working code, then implement provider-independent conversation and avatar contracts, one functional Live2D character path, OpenAI/Gemini/Local provider adapters, normalized interruption/listening/speaking events, audio-driven lip sync, behavior layering, and free-talk/interview persona switching. Do not fake unavailable proprietary Live2D components or cloud credentials: mark them BLOCKED_BY_* while completing everything else. Use the official sources in docs/source-manifest.md, use LiveKit Docs MCP for current APIs, test each gate, and do not stop at scaffolding. The goal is a demonstrably runnable end-to-end path with evidence, not architecture-only code.
