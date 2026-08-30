# Integration contracts (fixed before parallel implementation)

All packages are `@rcai/<name>`, ESM, `main: ./src/index.ts`. Never import a vendor SDK from `apps/web`.

## Provider constructors (browser side)
| Package | Export | Notes |
|---|---|---|
| `@rcai/provider-openai` | `new OpenAIRealtimeProvider({ brokerUrl, model?, defaultVoice? })` | WebRTC. `attachInputStream(mic)` + `getOutputStream()`; `pushAudio` is a no-op when a stream is attached. `createOpenAIEvaluationProvider({ brokerUrl })` calls `POST /api/evaluate`. `openaiPromptAdapter: PromptAdapter`. |
| `@rcai/provider-gemini` | `new GeminiLiveProvider({ brokerUrl, model? })` | WSS with ephemeral token. Consumes `pushAudio` 48k frames → 16k PCM16; emits 24k output as 48k `assistant_audio` frames. `createGeminiEvaluationProvider({ brokerUrl })`. `geminiPromptAdapter`. |
| `@rcai/provider-local` | `new LocalProvider({ agentUrl })` | WebSocket local bus to `services/agent`. `createLocalEvaluationProvider({ agentUrl })`, `LocalSTTProvider`. Under `strict_local` the provider refuses non-loopback `agentUrl`. |

## Avatar constructors (browser side)
| Package | Export | Notes |
|---|---|---|
| `@rcai/avatar-live2d` | `new Live2DAvatarProvider({ container: HTMLElement, coreUrl?, scheduler? })` | extends `MotionStackAvatarBase`. Loads Cubism Core from `coreUrl` (default: `/vendor/live2d/live2dcubismcore.min.js` if present else official CDN). `motionSyncCoreUrl?` slot → BLOCKED_BY_MOTIONSYNC_CORE when absent (uses `AnalyzerLipSync`). |
| `@rcai/avatar-canvas` | `new CanvasAvatarProvider({ container })` | **DEV/DEBUG renderer only** (never counts as Gate 2 PASS). Same params → drawn 2D face. |
| `@rcai/avatar-vrm` | `new VRMAvatarProvider({ container })` | three + @pixiv/three-vrm; humanoid bones, expressionManager, lookAt, springBone. |
| `@rcai/avatar-liveavatar` | `new LiveAvatarProvider({ brokerUrl, container })` | HeyGen streaming (LiveKit). Cloud only; ignores MotionStack. |
| `@rcai/avatar-tavus` | `new TavusAvatarProvider({ brokerUrl, container })` | Tavus CVI (Daily room). Cloud only. |

Every avatar provider exposes `getParams()`; MotionStack-based ones also `blink/setMicroMotion/playMotion`.

## Content packages
- `@rcai/characters` (`characters/index.ts`): `characters: CharacterEntry[]` `{ id, name, renderer, baseUrl: "/characters/<id>", license, defaultPersona }`; each dir has `manifest.json`, `character.json`, `model/` (git-ignored proprietary/licensed files, populated by `scripts/fetch-sample-character.sh`), `expressions/`, `motions/`.
- `@rcai/personas` (`personas/index.ts`): `personas: Persona[]`, `createPersonaRegistry()`; JSON under `personas/<dir>/*.json`.
- `apps/web/public/characters` → symlink to `../../characters` (served statically).

## services/token-broker — `http://localhost:8787`
Env: `OPENAI_API_KEY`, `GEMINI_API_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `HEYGEN_API_KEY`, `TAVUS_API_KEY`, `TAVUS_REPLICA_ID`, `TAVUS_PERSONA_ID`, `PORT`. CORS: `http://localhost:5173`.
| Route | Body | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true, providers: { openai, google, livekit, heygen, tavus } }` (booleans = key configured) |
| `POST /api/token/openai` | `{ model?, voice?, instructions?, language? }` | `{ clientSecret, expiresAt, model, baseUrl: "https://api.openai.com/v1/realtime" }` via `POST https://api.openai.com/v1/realtime/client_secrets` |
| `POST /api/token/gemini` | `{ model? }` | `{ token, expiresAt, model }` via `POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens` |
| `POST /api/evaluate` | `{ providerId: "openai"\|"google", input: EvaluationInput }` | `EvaluationResult` |
| `POST /api/plan` | `MotionPlanInput` | `MotionPlan` (cloud LLM; heuristic fallback) |
| `POST /api/livekit/token` | `{ room, identity }` | `{ url, token }` |
| `POST /api/avatar/heygen/session` | `{ avatarId?, voiceId? }` | `{ sessionId, url, accessToken, ... }` |
| `POST /api/avatar/tavus/conversation` | `{ personaId?, replicaId? }` | `{ conversationId, conversationUrl }` |
Missing key ⇒ `503 { error: "BLOCKED_BY_<X>_KEY" }`.

## services/agent — `http://localhost:8788` (HTTP + WebSocket)
Env: `LOCAL_STT=sherpa|whisper` (default sherpa), `SHERPA_MODEL_DIR`, `WHISPER_SERVER_URL` (default `http://127.0.0.1:8178`), `LOCAL_LLM_URL` (OpenAI-compatible, default `http://127.0.0.1:8080/v1`), `LOCAL_LLM_MODEL`, `LOCAL_TTS=say|sbv2` (default say), `SBV2_URL` (default `http://127.0.0.1:5000`), `SAY_VOICE` (default `Kyoko`), `PORT`.
| Route | Body | Response |
|---|---|---|
| `GET /health` | — | `{ ok, strictLocalCapable: true, stt: { engine, ready }, llm: { engine, ready, model }, tts: { engine, ready } }` |
| `POST /plan` | `MotionPlanInput` | `MotionPlan` |
| `POST /evaluate` | `EvaluationInput` | `EvaluationResult` |
| `WS /session` | see below | |

WS protocol (`/session`):
- client → text JSON: `{ type: "start", config: SessionConfig }`, `{ type: "text", text }`, `{ type: "interrupt" }`, `{ type: "update_context", context }`, `{ type: "stop" }`
- client → binary: Int16LE PCM **16 kHz mono**, ~20 ms chunks (client converts from internal 48k with `OutboundAudioConverter`)
- server → text JSON: `{ type: "ready" }`, `user_speech_started`, `user_speech_ended`, `{ type: "user_transcript", text, final }`, `assistant_thinking`, `assistant_speech_started`, `{ type: "assistant_transcript", text, final }`, `assistant_speech_ended`, `interrupted`, `{ type: "error", message }`
- server → binary: `[uint32 LE sampleRate][Int16LE PCM mono]` — assistant audio chunks
- `config.privacyMode === "strict_local"` ⇒ agent rejects any non-loopback adapter URL and disables `/plan` cloud fallbacks.

## services/evaluation (`@rcai/evaluation`, framework-agnostic)
`sessionRecordToEvaluationInput(record, params?)`, `HeuristicEvaluator` (id `local`, no network), `buildEvaluationPrompt(input)`, `EVALUATION_JSON_SCHEMA`, `parseEvaluationResult(text)`, `evaluateWithOpenAICompatible({ baseUrl, apiKey?, model, fetch? }, input)`, `evaluateWithGemini({ apiKey, model }, input)`.

## Meeting participation (P0-1) — `@rcai/meeting-core`, `@rcai/connector-recall`
`MeetingConnector { id: "recall"|"zoom_native"|"google_native"; capabilities(); join(req): Promise<MeetingSession> }` ·
`MeetingSession { id; platform; status(); onEvent(cb); pushOutboundAudio(frame); endOutboundUtterance?(); leave() }` ·
`MeetingEvent = status | joined | left | audio(frame 48k) | transcript(text, final, speakerName) | participant_joined/left | speech(active) | error` ·
`ParticipationPolicy` (pure): OBSERVING → LISTENING → ADDRESSED → RESPONDING → OBSERVING; `proactivity: addressed_only | invited | active`, `cooldownMs`, `maxConsecutiveResponses`; `AddressDetector` (JP/EN name + request detection, third-person filtered).
Web factory: `createMeetingConnector("recall", { brokerUrl, privacyMode, mode?: "output_media"|"relay", botPageQuery? })` (throws `BLOCKED_BY_STRICT_LOCAL` under strict_local).

Recall connector modes:
- **output_media** (default, recommended by Recall for agents): the bot streams **our web app** (`RECALL_BOT_PAGE_URL/?rcai_bot=1&token=<signed bot_page token>` — nothing else in the URL; character/persona/engine/name are returned by `POST /api/meeting/session/activate`) as its camera; inside the bot the page gets meeting audio via `getUserMedia` (no prompt), plays the character's voice natively into the meeting and shows the Live2D avatar as video. Transcripts with speaker names come from `wss://meeting-data.bot.recall.ai/api/v1/transcript`.
- **relay**: Recall's realtime websocket (`audio_mixed_raw.data` 16 kHz S16LE base64 200 ms, `transcript.data/partial_data`, `participant_events.*`) is received by the broker at `wss://RECALL_PUBLIC_URL/api/meeting/recall/relay/{token}/` and fanned out to browsers at `ws://localhost:8787/api/meeting/recall/client/{botId}`; audio out = MP3 clips via `POST /api/meeting/recall/bots/{id}/output_audio` (needs an `mp3Encoder`; otherwise `BLOCKED_BY_MP3_ENCODER`).

Broker routes (`services/token-broker`, env `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_PUBLIC_URL`, `RECALL_BOT_PAGE_URL`):
| Route | Body | Response |
|---|---|---|
| `POST /api/meeting/recall/bots` | `{ meetingUrl, botName?, mode?, language?, botPageQuery? }` | `{ botId, status, mode, clientWsUrl, botPageUrl?, region }` — 503 `BLOCKED_BY_RECALL_KEY` / `BLOCKED_BY_RECALL_PUBLIC_URL` |
| `GET /api/meeting/recall/bots/:id` | — | `{ botId, code, subCode, statusChanges[] }` (Recall status codes) |
| `POST /api/meeting/recall/bots/:id/leave` | — | `{ ok }` |
| `POST /api/meeting/recall/bots/:id/output_audio` | `{ kind: "mp3", b64_data }` | `{ ok }` |
| `POST /api/meeting/recall/bots/:id/output_media/restart` | — | `{ ok, restarts }` — stops + restarts the Output Media page with a fresh single-use token (watchdog recovery) |
| `POST /api/meeting/session/activate` | `{ token }` (bot_page) | 200 `{ sessionId, botId, botName, mode, botPageQuery, clientWsUrl, clientToken, activations }` · 401 `{ error: "invalid_bot_page_token", detail: expired|replayed|revoked|ended|bad_signature|… }` |
| `GET /api/meeting/session/:id` | `Authorization: Bearer <clientToken>` | `{ sessionId, botId, revoked, ended, endReason, botPageActivatedAt, activations, outputMediaRestarts }` |
| `POST /api/meeting/session/:id/refresh` | operator bearer + `{ role: "bot_page"|"client" }` | `{ token, role, botPageUrl? }` (relay tokens are not refreshable) |
| `POST /api/meeting/session/:id/revoke` | operator bearer | `{ ok, revoked }` — all tokens of the session die immediately; relay clients closed |
| `WS /api/meeting/recall/relay/{relayToken}/` | Recall → broker | signed `relay` token (6 h), verified on upgrade **and on every message**; 401 otherwise |
| `WS /api/meeting/recall/client/{botId}?token=…` | browser → broker | signed `client`/`bot_page` token (60 min / 15 min), `botId` must match the session; re-verified every 10 s (close 1008 on revoke/expiry) |

### Meeting session security & lifecycle (Round 3 Gate 5)
- Tokens: `base64url(payload).base64url(HMAC-SHA256)` with `{ sid, bot, role, exp, iat, nonce, brk }`; secret `MEETING_TOKEN_SECRET` (ephemeral when unset). TTLs: bot_page ≤ 15 min (single activation; replay → 401), client 60 min, relay 6 h. Server registry adds revoke / end / botId binding / nonce burn / TTL sweep (ended 5 min, idle 6 h).
- `createRecallBot` returns `{ botId, sessionId, clientToken, clientWsUrl(with token), botPageUrl(signed), botPageTokenExpiresAt }`; same meeting URL while a session is live → `409 DUPLICATE_JOIN` unless `force: true`.
- Lifecycle (`@rcai/meeting-core` `MeetingLifecycle`, pure): `created → joining → waiting_room → admitted → (reconnecting ⇄ admitted) | denied | removed | ended | left | failed`; `mapRecallStatus(code, sub_code)` implements docs.recall.ai sub-codes (kicked → removed, waiting-room kick/timeout/knocking disabled → denied, host/idle/everyone-left → ended, `bot_received_leave_call` → left, other fatal → failed). `MeetingStatus` gained `reconnecting | denied | removed | ended`; `MeetingEvent` gained `audio_muted`.
- `RecallSession`: relay drop after admission → `reconnecting` with 1 s→8 s backoff (60 s budget → `failed`); output_media watchdog: no bot-page activation within 20 s of admission → `POST …/output_media/restart` once → `failed`; host mute (`setAudioMuted`, best-effort from `participant_events.update`) pauses outbound audio; every terminal state cleans timers/sockets and later vendor codes are ignored.
- Web: the bot page activates its token exactly once (`activateBotPage`) before starting; `MeetingSessionController` holds speech while muted / waiting room / reconnecting, resets `ParticipationPolicy` on reconnect and tears down on denied/removed/ended/failed.
