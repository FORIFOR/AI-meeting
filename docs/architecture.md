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

VRM local rendering (2026-09-12): `SpeakerOutput.tap → AvatarRuntime → WLipSyncEngine → local Worker / wlipsync@1.3.1 WASM → VRM 1.0 expressions`. The analyzer does not create an audio graph or schedule audio. Startup and failed/stale analysis use the existing `AnalyzerLipSync`, and interruption resets a generation epoch before old Worker results can affect the mouth. Model fetch/parse is cancellable with disposal of late parse results. VRM model/WebGL failure selects the existing local canvas fallback; it never selects a cloud renderer. Requested/actual renderer identities are recorded after preparation. The OSS build uses a dedicated asset allowlist, VRM-only character list, separate local settings, removed external font links, and excludes optional proprietary/service adapter chunks. The standard hosted build retains Yui as the first/default character.

Optional synchronized video rendering (2026-09-11): `ConversationRuntime → SynchronizedAvatarSink → AvatarProvider.synchronizedAudio → returned AV → SpeakerOutput`. Source PCM is submitted before playback; SpeakerOutput.tap remains downstream observation only. `DualRenderer` prepares the original character renderer and selects external media only when both tracks are ready. The character/persona/voice identity remains unchanged. `endTurn` closes source input without cancelling returned media. Because the current Anam passthrough protocol lacks a returned-AV turn/EOF acknowledgement, explicit interruption and the next half-duplex user turn after source submission stop that external session and continue in the local renderer. Meeting natural mode is limited to combined AV page capture; socket/clip paths stay local. See [implementation and current limitations](../avatar-providers/anam/README.md).

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
