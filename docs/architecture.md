# Architecture

```
apps/web (React)           ── never imports a vendor SDK directly
   │
   ├─ @rcai/conversation-core   ConversationRuntime · ConversationEvent · SessionRecord · policy
   ├─ @rcai/provider-core       RealtimeAIProvider · ProviderRouter · EvaluationProvider · privacyGuard
   ├─ @rcai/audio-core          48k float32 mono · MicCapture · SpeakerOutput(tap) · VAD · LatencyTracker
   ├─ @rcai/avatar-core         AvatarProvider · AvatarStateMachine · MotionStack · MotionLibrary · LipSync
   ├─ @rcai/behavior-engine     FastBehaviorEngine · ListeningScheduler · Blink/Gaze/Breath · SemanticMotionPlanner
   └─ @rcai/persona-core        Persona · buildSystemPrompt · VoiceProfile
providers/openai|gemini|local  → RealtimeAIProvider (native events → ConversationEvent)
avatar-providers/live2d|vrm|canvas|liveavatar|tavus → AvatarProvider
services/token-broker (ephemeral credentials) · services/agent (local bus: VAD/STT/LLM/TTS + planner) · services/evaluation (sidecar)
```

Data flow (spec §2): `Mic → ConversationRuntime → Provider → ConversationEvent → {SpeakerOutput, AvatarRuntime, BehaviorEngine, Evaluator}`.
AI and Avatar are never connected directly.

## Boundaries
- Provider adapters convert audio at their boundary (`OutboundAudioConverter`, `AudioNormalizer`).
- `SpeakerOutput.tap` emits the PCM that is actually played → `AvatarRuntime.pushAudio` → `LipSyncEngine`.
- Interruption fast path: `ConversationRuntime` calls `sink.interrupt()` on `user_speech_started` while speaking, then `AvatarRuntime` gets `interrupted` → `provider.interrupt()` closes the mouth (< 100 ms).
- `SemanticMotionPlanner` runs async; results are applied when they arrive.
- `strict_local`: `resolveRouting` forces local for every role and `privacyGuard.assert` throws on cloud egress.

## Key types
- `ConversationEvent` — `packages/conversation-core/src/events.ts`
- `RealtimeAIProvider` / `ProviderCapabilities` — `packages/provider-core/src/provider.ts`
- `AvatarProvider` / `AvatarState` — `packages/avatar-core/src/types.ts`
- `Persona` — `packages/persona-core/src/persona.ts`
