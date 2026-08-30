# Gate 5 — Gemini Live adapter (`@rcai/provider-gemini`)

Date: 2026-08-30 · Status: **code + unit tests PASS · device test BLOCKED_BY_GEMINI_KEY**

## Files
| File | Purpose |
|---|---|
| `providers/gemini/src/protocol.ts` | Wire types (setup / clientContent / realtimeInput / toolResponse, server union), `geminiWssUrl()`, `parsePcmRate()`, constants (default model `gemini-2.5-flash-native-audio-preview-12-2025`, 16 k in / 24 k out) |
| `providers/gemini/src/geminiLiveProvider.ts` | `GeminiLiveProvider implements RealtimeAIProvider` (id `google`) |
| `providers/gemini/src/promptAdapter.ts` | `geminiPromptAdapter` (policy rendered last + language pin for native-audio auto-detect) |
| `providers/gemini/src/evaluation.ts` | `createGeminiEvaluationProvider({ brokerUrl })` → `POST /api/evaluate` `{ providerId: "google" }` |
| `providers/gemini/src/gemini.test.ts` | 8 vitest cases with injected fake WebSocket + fetch |
| `providers/gemini/src/index.ts` | exports |

No new dependencies (native `WebSocket`, workspace packages only). No files outside `providers/gemini/**` and this report were touched.

## Behaviour
- `connect()` → `privacyGuard.assert(privacyMode, "cloud_conversation")` → `POST {brokerUrl}/api/token/gemini {model}` → WSS `…/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?access_token=<token>` → `setup` → wait `setupComplete` (10 s timeout) → `session_ready`.
- Setup: `models/<model>`, `generationConfig.responseModalities:["AUDIO"]`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (from `SessionConfig.voice`), `enableAffectiveDialog` (default on), `systemInstruction.parts[0].text` (persona + §22 policy), `inputAudioTranscription:{}`, `outputAudioTranscription:{}`, `realtimeInputConfig.automaticActivityDetection` (default `{disabled:false, silenceDurationMs:500, prefixPaddingMs:100}`), optional `proactivity.proactiveAudio`, `tools.functionDeclarations`, `sessionResumption.handle` on reconnect. `languageCode` is only sent for non-native-audio models (docs: native audio auto-detects).
- `pushAudio()` 48 k → `OutboundAudioConverter(16 kHz, 20 ms)` → `realtimeInput.audio {data: base64 PCM16, mimeType:"audio/pcm;rate=16000"}` (640-byte chunks). A local `EnergyVAD` emits `user_speech_started/ended` (Gemini sends no user-activity events; `ConversationRuntime` dedupes).
- Inbound `serverContent.modelTurn.parts[].inlineData` (`audio/pcm;rate=24000`) → Int16 → Float32 → `AudioNormalizer` → 48 k `assistant_audio`; first audio part of a turn emits `assistant_speech_started`; `turnComplete` schedules `assistant_speech_ended` after the estimated remaining playback (`Σ frame ms − elapsed since first audio`), cancelled by interruption.
- `serverContent.interrupted` → `interrupted` (playback state dropped). `inputTranscription.text` fragments are accumulated → `user_transcript {final:false}`, finalised (`final:true`) when the model starts answering or at `turnComplete`. `outputTranscription.text` → `assistant_transcript {final:false}` deltas, full text with `final:true` at `turnComplete`. `toolCall.functionCalls[]` → `tool_call`; `sendToolResponse()` → `toolResponse.functionResponses`. `goAway` → non-fatal `error` + best-effort reconnect (new token, new socket, resumption handle if received). Socket close → `session_closed`.
- `interrupt()`: no dedicated cancel message exists; API reference states a `clientContent` message "will interrupt any current model generation" → sends `{clientContent:{turnComplete:false}}` and emits `interrupted` locally. **Device-untested.**
- `updateContext()`: `systemInstruction` is immutable after setup → appends a user-role "(System update …)" note via `clientContent` with `turnComplete:false` (no generation triggered). Documented limitation.
- `pushImage()` → `realtimeInput.video {data, mimeType}` (data URL or bytes).
- Capabilities: nativeAudio/vision/toolCalling/realtimeTranscript/interruption/emotionUnderstanding = true, localOnly = false, extras `{bargeIn, proactiveAudio, affectiveDialog, vision, liveTranscription}`.
- `strict_local` → `PrivacyViolationError` before any network call (conversation and evaluation).

## Commands & results
```
pnpm vitest run providers/gemini      → 1 file, 8 tests passed
cd providers/gemini && npx tsc -p tsconfig.json → exit 0
pnpm vitest run                       → 11 files, 68 tests passed (whole repo, nothing broken)
```
Tests cover: token fetch + WSS URL, setup contents (voice, transcription, VAD, affective dialog, tools, proactive audio, prompt adapter), 48 k→16 k PCM16 base64 640-byte chunks + local VAD events, 24 k→48 k frame lengths, transcript ordering/finalisation, delayed `assistant_speech_ended`, `interrupted`, `toolCall`/`toolResponse`, explicit `interrupt()`, `sendText`, `updateContext`, `goAway` reconnect, strict_local rejection, broker `BLOCKED_BY_GEMINI_KEY` propagation, evaluation provider.

## Documentation consulted (field names relied on)
- https://ai.google.dev/api/live — WSS endpoint `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`; client union `setup | clientContent | realtimeInput | toolResponse`; `BidiGenerateContentSetup {model, generationConfig, systemInstruction, tools, realtimeInputConfig, sessionResumption, inputAudioTranscription, outputAudioTranscription, proactivity}`; `clientContent {turns[], turnComplete}` ("A message here will interrupt any current model generation"); `realtimeInput {audio, video, text, activityStart, activityEnd, audioStreamEnd}`; server union `setupComplete | serverContent | toolCall | toolCallCancellation | goAway | sessionResumptionUpdate | usageMetadata`; `serverContent {modelTurn, turnComplete, interrupted, generationComplete, inputTranscription, outputTranscription}`; `goAway.timeLeft`; `sessionResumptionUpdate {newHandle, resumable}`; `toolCall.functionCalls[]`, `toolResponse.functionResponses[]`.
- https://ai.google.dev/gemini-api/docs/live-guide — `realtimeInput.audio.mimeType:"audio/pcm;rate=16000"`, output 24 kHz PCM16 via `modelTurn.parts[].inlineData.data`, `inputAudioTranscription:{}` / `outputAudioTranscription:{}`, `serverContent.inputTranscription.text` / `outputTranscription.text`, `automaticActivityDetection {disabled, startOfSpeechSensitivity, endOfSpeechSensitivity, prefixPaddingMs, silenceDurationMs}`, `realtimeInput.video.mimeType:"image/jpeg"`.
- https://ai.google.dev/gemini-api/docs/live-api/capabilities — `enableAffectiveDialog` (v1beta), `proactivity.proactiveAudio`, `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (e.g. `Kore`).
- https://ai.google.dev/gemini-api/docs/ephemeral-tokens — `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens {uses, expireTime, newSessionExpireTime, liveConnectConstraints}`; token = `name`; used as `access_token` query param (or `Authorization: Token …`); v1beta.
- https://ai.google.dev/gemini-api/docs/models — Live models: `gemini-2.5-flash-native-audio-preview-12-2025` (default here), `gemini-3.1-flash-live-preview` (preview; selectable via `model`).
- Not verifiable from docs (SDK-derived, flagged): placement of `enableAffectiveDialog` under `generationConfig` follows the `@google/genai` SDK converter; if the live service rejects it, move it to the setup root (`GeminiSetup` type already allows editing in `buildSetup`).

## Blocked / unverified
| Item | Status | Unblock |
|---|---|---|
| Real Gemini Live round-trip (audio in/out, barge-in, transcripts, affective dialog, `interrupt()` semantics, `enableAffectiveDialog` placement) | **BLOCKED_BY_GEMINI_KEY** | 1) `export GEMINI_API_KEY=…` in `services/token-broker/.env`; 2) start broker (`pnpm dev:broker`) and confirm `POST /api/token/gemini` returns `{token}`; 3) run the web app with engine = Google Gemini and exercise Gate A/D; 4) if setup is rejected, check the `error` event text and adjust `buildSetup()` field placement. |
| Token broker `/api/token/gemini` endpoint | owned by Fork B | must call `v1beta/auth_tokens` with `liveConnectConstraints.model` = requested model and return `{ token: name, expiresAt, model }` |
