# Gate 4 — OpenAI Realtime adapter + token broker (Fork B, 2026-08-30)

## Status
- Code + unit tests: **PASS** (16 tests, typecheck clean).
- Broker runtime smoke: **PASS** (started, `/health`, 503 `BLOCKED_BY_*`, `/api/plan` heuristic, CORS preflight).
- Real-device conversation (mic → WebRTC → gpt-realtime → speaker): **BLOCKED_BY_OPENAI_KEY** — `OPENAI_API_KEY` is not set anywhere in this environment.
- HeyGen route shapes: UNVERIFIED (developers.heygen.com reference pages returned 404; implemented per StreamingAvatar SDK flow) → also BLOCKED_BY_HEYGEN_KEY.

## Files
services/token-broker: `src/server.ts`, `src/app.ts` (Hono, CORS 5173/5180, injectable fetch/now), `src/env.ts` (manual `.env` loader, process.env wins, empty=unset), `src/routes/{openai,gemini,livekit,heygen,tavus,plan}.ts`, `src/evaluation-bridge.ts` (dynamic import of `@rcai/evaluation`; labelled `heuristic-fallback` if absent), `src/index.ts`, `src/app.test.ts`, `.env.example`.
providers/openai: `src/events.ts` (`OpenAIEventMapper`, stateful, legacy names), `src/prompt.ts` (`openaiPromptAdapter`), `src/provider.ts` (`OpenAIRealtimeProvider`), `src/evaluation.ts` (`createOpenAIEvaluationProvider`), `src/index.ts`, `src/openai.test.ts`.

## API shapes used (verified via WebFetch, 2026-08-30)
- https://developers.openai.com/api/docs/guides/realtime-webrtc — `POST https://api.openai.com/v1/realtime/calls` (`Content-Type: application/sdp`, `Authorization: Bearer <ephemeral>`), data channel `oai-events`, `POST /v1/realtime/client_secrets` body `{ session: { type:"realtime", model, audio:{ output:{ voice } } } }`. (platform.openai.com URLs 301 → developers.openai.com.)
- https://developers.openai.com/api/docs/api-reference/realtime-sessions/create-realtime-client-secret — `expires_after{anchor,seconds}`, `session.instructions`, `session.audio.input/output`, response `{ value:"ek_…", expires_at, session }`.
- https://developers.openai.com/api/docs/api-reference/realtime-client-events/session/update — `session.audio.input.{format,noise_reduction,transcription{model,language,prompt},turn_detection}`, `session.audio.output.{format,voice,speed}`.
- https://developers.openai.com/api/docs/guides/realtime-vad — `turn_detection: { type:"server_vad"|"semantic_vad", threshold, prefix_padding_ms, silence_duration_ms, create_response, interrupt_response, eagerness }`.
- https://developers.openai.com/api/docs/guides/realtime-transcription — `session.audio.input.transcription.model = "gpt-live-transcribe"` (recommended) / `"gpt-transcribe"`.
- https://developers.openai.com/api/docs/api-reference/realtime-server-events — `input_audio_buffer.speech_started/stopped`, `conversation.item.input_audio_transcription.delta(delta)/completed(transcript)`, `response.created`, `response.output_audio_transcript.delta(delta)/done(transcript)`, `response.function_call_arguments.done(call_id,name,arguments)`, `response.done`, `error{type,message,code}`.
- https://developers.openai.com/api/docs/guides/realtime-conversations — `conversation.item.create` (`input_text`, `input_image` data URL), `response.create`, `response.cancel` + `output_audio_buffer.clear` (WebRTC cut-off). Note: `output_audio_buffer.started/stopped/cleared` server events are not in the page excerpt the fetcher returned; they are kept as the primary speech-start/stop signal (WebRTC-only events) and `response.done{status:"cancelled"}` is handled as a fallback interruption signal.
- https://ai.google.dev/gemini-api/docs/ephemeral-tokens — `POST https://generativelanguage.googleapis.com/v1beta/auth_tokens` (`x-goog-api-key`), body `{ uses, expireTime, newSessionExpireTime, liveConnectConstraints{model} }`, token = `response.name`, connect with `?access_token=` or `Authorization: Token …`. (Contract said v1alpha; docs now say **v1beta** — implemented v1beta.)
- https://docs.tavus.io/api-reference/conversations/create-conversation — `POST https://tavusapi.com/v2/conversations` (`x-api-key`); current spec uses `face_id`/`pal_id` (legacy `replica_id`/`persona_id` also forwarded); response `conversation_id`, `conversation_url`, `status`.
- HeyGen: docs.heygen.com → developers.heygen.com redirect, all reference pages 404. Implemented `streaming.create_token` (x-api-key) → `streaming.new` (Bearer session token; `avatar_id`, `voice.voice_id`, `version:"v2"`, `video_encoding:"H264"`) → `streaming.start`. UNVERIFIED.

## Design notes
- Provider never sees an API key: broker mints the ephemeral secret (`expires_after 600 s`), instructions/voice/transcription/VAD are set both in the secret and re-sent via `session.update` after the data channel opens.
- `attachInputStream(mic)` is the preferred path; without it `pushAudio()` frames are rendered into a lazily created `MediaStreamAudioDestinationNode` and that track is offered in the SDP.
- Remote track → `getOutputStream()` → `ConversationRuntime` attaches it to `SpeakerOutput` (lip sync taps the played audio, spec §14).
- `interrupt()` = `response.cancel` + `output_audio_buffer.clear`; mapper turns `output_audio_buffer.cleared` into `interrupted` and suppresses a duplicate `assistant_speech_ended`.
- User transcript deltas are accumulated per `item_id` and emitted as full text `final:false` (runtime replaces user partials, appends assistant partials).
- `strict_local` ⇒ `connect()` throws `PrivacyViolationError` before any network call; same for the evaluation provider.
- Broker `/api/evaluate` uses `@rcai/evaluation` contract names via dynamic import; until that package lands, responses are explicitly labelled `evaluatedBy: "heuristic-fallback"` (never presented as an LLM score).

## Commands run
```
pnpm --filter @rcai/provider-openai typecheck   # exit 0
pnpm --filter @rcai/token-broker typecheck      # exit 0
pnpm vitest run providers/openai services/token-broker
#  ✓ providers/openai/src/openai.test.ts (7 tests)
#  ✓ services/token-broker/src/app.test.ts (9 tests)
#  Test Files 2 passed, Tests 16 passed
PORT=8799 pnpm --filter @rcai/token-broker start   # "[token-broker] listening on http://127.0.0.1:8799 configured=[none]"
curl http://127.0.0.1:8799/health
#  {"ok":true,"providers":{"openai":false,"google":false,"livekit":false,"heygen":false,"tavus":false}}
curl -i -X POST http://127.0.0.1:8799/api/token/openai -d '{"voice":"marin"}'
#  HTTP/1.1 503 Service Unavailable  {"error":"BLOCKED_BY_OPENAI_KEY"}
curl -X POST http://127.0.0.1:8799/api/token/gemini -d '{}'
#  {"error":"BLOCKED_BY_GEMINI_KEY"}
curl -i -X POST http://127.0.0.1:8799/api/plan -d '{"speaker":"assistant","text":"それは、とても良い回答ですね。","mode":"free_talk"}'
#  x-plan-source: heuristic  {"emotion":"warm_positive","gesture":"nod_normal",...}
curl -i -X OPTIONS ... -H 'Origin: http://localhost:5173'   # access-control-allow-origin: http://localhost:5173
pkill -f "tsx src/server.ts"   # stopped
```
Unit tests cover: GA + legacy event mapping table, interruption dedupe, error/fatal flag, prompt adapter, full `connect()` flow with a fake `RTCPeerConnection` (broker call body, `/calls?model=` URL, Bearer header, `application/sdp`, remote track, `session.update` contents, opening `response.create`), `interrupt`/`sendText`/`updateContext`/`disconnect`, strict_local rejection, broker error propagation, evaluation provider; broker: health, 503 per missing key, OpenAI client-secret body shape, 401→BLOCKED, Gemini v1beta body/times, plan heuristic/LLM/fallback, LiveKit JWT, Tavus/HeyGen endpoint order + headers, `.env` parser.

## To unblock the device test (human action)
1. Create `services/token-broker/.env` with `OPENAI_API_KEY=sk-…` (see `.env.example`; keys stay server-side).
2. `pnpm --filter @rcai/token-broker start` → `/health` shows `"openai": true`; `POST /api/token/openai` returns `{ clientSecret:"ek_…", expiresAt, model, baseUrl }`.
3. In the web app choose AI Engine = OpenAI; expected evidence: `session_ready` → speak → `user_speech_started/ended` → `assistant_thinking` → `assistant_speech_started` (audio on `getOutputStream()`, avatar lip-syncs from the speaker tap) → `assistant_transcript` → `assistant_speech_ended`; barge-in produces `interrupted` (`output_audio_buffer.cleared`) and the `LatencyTracker` `turn_response` / `interrupt_stop` samples fill the KPI panel.
