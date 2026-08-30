# Gate 10 report — VRM 3D provider + realistic (HeyGen LiveAvatar / Tavus) adapters

Date: 2026-08-30 · Fork G

## Files written
| Path | Purpose |
|---|---|
| `avatar-providers/vrm/src/mapping.ts` | Pure `mapParamsToVRM(AvatarParams) → VRMPose` (head/neck/spine/chest/arms/hands Euler in rad, VRM expression weights incl. visemes `aa/ih/ou/ee/oh`, blink, `happy/sad/angry/surprised/relaxed`, look-at offset, breath scale). Arm gestures ×2 (`ARM_GESTURE_SCALE`), rest drop `ARM_REST_RAD`. |
| `avatar-providers/vrm/src/VRMAvatarProvider.ts` | `VRMAvatarProvider extends MotionStackAvatarBase` (`id: "vrm"`): three.js renderer/camera/lights in `container`, `GLTFLoader` + `VRMLoaderPlugin`, `VRMUtils.removeUnnecessaryVertices/removeUnnecessaryJoints/combineSkeletons/combineMorphs/rotateVRM0`, `humanoid.getNormalizedBoneNode(...)` rotations, `expressionManager.setValue`, `lookAt.target` Object3D driven by eyeBall params, chest breath scale, `vrm.update(dt)` (spring bones), ResizeObserver, `deepDispose` on stop. Options: `container`, `modelUrl` override, `background`, `cameraDistance`. |
| `avatar-providers/vrm/src/mapping.test.ts` | 5 unit tests: rest pose, viewer-relative sign conventions, viseme derivation, blink/emotion presets, arm amplification/clamp. |
| `avatar-providers/vrm/demo/{index.html,main.ts,vite.config.ts}` | Demo page (`pnpm --filter @rcai/avatar-vrm demo`, port 5181) loading `reference/ChatVRM/public/AvatarSample_B.vrm` via `/@fs/` with state/emotion/gesture/blink buttons. **NOT browser-tested in this fork.** |
| `avatar-providers/vrm/package.json` | + `demo` script, devDep `vite` (already in lockfile; `pnpm install --filter @rcai/avatar-vrm` ran, lockfile unchanged). |
| `avatar-providers/liveavatar/src/LiveAvatarProvider.ts` | HeyGen LiveAvatar LITE/custom-mode adapter implementing `AvatarProvider` directly (no MotionStack, §17). `prepare()` → `POST {broker}/api/avatar/heygen/session` → accepts `{sessionId|session_id, livekitUrl|livekit_url|url, livekitClientToken|livekit_client_token|accessToken, wsUrl|ws_url}` (also nested `data`). `start()` → livekit-client `Room.connect`, attaches remote video/audio; opens the command WebSocket. `pushAudio` → 48k→24k PCM16 base64 `{"type":"agent.speak","audio"}` chunks; `endSpeech()`/leaving SPEAKING → `agent.speak_end`; LISTENING → `agent.start_listening`/`agent.stop_listening`; `interrupt()` → `agent.interrupt`; `session.keep_alive` every 30 s; ws `agent.speak_started/ended`, `session.state_updated` → `onEvent`. `stop()` closes ws/room and best-effort `POST {broker}/api/avatar/heygen/stop {sessionId, reason:"USER_CLOSED"}`. 503 → `Error("BLOCKED_BY_HEYGEN_KEY")`. |
| `avatar-providers/liveavatar/src/liveavatar.test.ts` | 2 tests (jsdom, injected fetch/room/socket fakes). |
| `avatar-providers/tavus/src/TavusAvatarProvider.ts` | Tavus CVI adapter implementing `AvatarProvider` directly. `prepare()` → `POST {broker}/api/avatar/tavus/conversation` → `{conversationId|conversation_id, conversationUrl|conversation_url}`. `start()` → `@daily-co/daily-js` `createCallObject().join({url})`, attaches remote video/audio tracks, `setLocalAudio(false)` (our runtime owns the conversation; `publishMic` opt-in). `pushAudio` → Interactions Protocol `conversation.echo` `{modality:"audio", audio:<b64 PCM16>, sample_rate:24000, inference_id, done}` via `sendAppMessage(msg,"*")`; `endSpeech()` sends `done:true`; `speakText()` → echo `modality:"text"`; `respondTo()` → `conversation.respond`; `interrupt()` → `conversation.interrupt`. Observable `conversation.started_speaking/stopped_speaking` (`properties.role`), `conversation.utterance` → `onEvent`. `stop()` leaves/destroys the call and best-effort `POST {broker}/api/avatar/tavus/end`. 503 → `Error("BLOCKED_BY_TAVUS_KEY")`. |
| `avatar-providers/tavus/src/tavus.test.ts` | 2 tests (jsdom, fake Daily call). |
| `avatar-providers/*/src/index.ts` | exports |

## Commands run and results
```
pnpm install --filter @rcai/avatar-vrm          # "Lockfile is up to date" (vite already present)
pnpm --filter @rcai/avatar-vrm typecheck        # OK
pnpm --filter @rcai/avatar-liveavatar typecheck # OK
pnpm --filter @rcai/avatar-tavus typecheck      # OK
pnpm vitest run avatar-providers/vrm avatar-providers/liveavatar avatar-providers/tavus
  # Test Files 3 passed (3) · Tests 9 passed (9)
```

## Documentation consulted (APIs were not guessed)
- HeyGen LiveAvatar: https://docs.liveavatar.com/llms.txt · https://docs.liveavatar.com/api-reference/sessions/create-session-token.md (`POST https://api.liveavatar.com/v1/sessions/token`, `X-API-KEY`, `{mode:"LITE"|"FULL", avatar_id, …}` → `{data:{session_id, session_token}}`) · https://docs.liveavatar.com/api-reference/sessions/start-session.md (`POST /v1/sessions/start`, Bearer session_token → `{data:{session_id, livekit_url, livekit_client_token, livekit_agent_token?, ws_url?}}`) · https://docs.liveavatar.com/api-reference/sessions/stop-session.md (`POST /v1/sessions/stop {session_id, reason}`) · https://docs.liveavatar.com/docs/lite-mode/overview.md, lifecycle.md, events.md (WebSocket commands `agent.speak` base64 **PCM16 24 kHz**, `agent.speak_end`, `agent.interrupt`, `agent.start_listening`, `agent.stop_listening`, `session.keep_alive`; responses `agent.speak_started`, `agent.speak_ended`, `session.state_updated`). Note: `docs.heygen.com/reference/new-session` and `docs.heygen.com/docs/streaming-api` now redirect to developers.heygen.com and return 404; the current product is "LiveAvatar" (docs.liveavatar.com) — the adapter targets that API. GitHub README of StreamingAvatarSDK was unreachable (404 / GitHub MCP bad credentials).
- Tavus: https://docs.tavus.io/api-reference/conversations/create-conversation.md (`POST /v2/conversations`, `x-api-key`, → `conversation_id`, `conversation_url`) · https://docs.tavus.io/sections/conversational-video-interface/interactions-protocols/overview.md (`call.sendAppMessage(interaction,'*')`, `'app-message'`, `conversation.started_speaking/stopped_speaking` with `properties.role`) · https://docs.tavus.io/sections/conversational-video-interface/echo-mode (`pipeline_mode:"echo"`, `conversation.echo` audio shape `{modality, audio, sample_rate, inference_id, done}`) · https://andy-tavus.github.io/interactions-protocol-playground/ and https://docs.tavus.io/sections/conversational-video-interface/component-library/hooks (exact `conversation.echo` / `conversation.respond` / `conversation.interrupt` JSON).
- three-vrm: `reference/three-vrm/packages/three-vrm/examples/lookat.html`, `expressions.html`, `three-vrm-core/src/expressions/VRMExpressionPresetName.ts`, `humanoid/VRMHumanBoneName.ts`, `VRMUtils` sources; ChatVRM `src/features/emoteController/*` (expression/lookAt patterns, studied only).

## Broker routes required (Fork B / token-broker)
- `POST /api/avatar/heygen/session` → must call LiveAvatar `sessions/token` (mode `LITE`, `avatar_id`) then `sessions/start` and return `{ sessionId, livekitUrl, livekitClientToken, wsUrl }` (adapter also accepts snake_case / `url`+`accessToken`). Optional `POST /api/avatar/heygen/stop { sessionId, reason }`.
- `POST /api/avatar/tavus/conversation` → `POST https://tavusapi.com/v2/conversations` and return `{ conversationId, conversationUrl }`; the PAL/persona must be created with `pipeline_mode: "echo"` for audio echo. Optional `POST /api/avatar/tavus/end { conversationId }`.

## Integration notes / limitations
- Realistic providers must be fed the **assistant PCM frames** (e.g. from `assistant_audio` events) rather than the local speaker tap, and local playback should be muted — the avatar's LiveKit/Daily track returns the synchronized audio+video (spec §17). Web app wiring (Fork F) should branch on `provider.id === "liveavatar" | "tavus"`.
- `setEmotion/performGesture/setGaze` are no-ops on both cloud adapters: neither LiveAvatar LITE nor Tavus CVI exposes per-parameter facial control; internal animation is used (spec §17).
- LiveAvatar without `ws_url` (FULL mode token) cannot be driven by our audio; the adapter emits an `error` event explaining it. HeyGen "custom TTS" FULL mode (ElevenLabs only) was not implemented.
- Tavus audio echo requires an echo-mode PAL; `speakText()` works with any PAL as a text fallback.
- VRM: `AvatarSample_B.vrm` in `reference/ChatVRM/public` is pixiv/VRoid sample avatar material distributed with the MIT-licensed ChatVRM repo; it is **not** copied into `characters/` — usage follows the VRoid sample-model terms; demo loads it in place via `/@fs/`.
- VRM0 models are normalised with `VRMUtils.rotateVRM0`; bone mapping uses normalized bones (VRM1 T-pose), so rest arm drop is applied every frame.

## Status
| Item | Status |
|---|---|
| VRM mapping + provider (typecheck, unit tests) | PASS (9/9 tests) |
| VRM browser render | **NOT VERIFIED (no browser access in this fork)** — run `pnpm --filter @rcai/avatar-vrm demo` → http://localhost:5181 |
| HeyGen LiveAvatar adapter | code + tests PASS; live session **BLOCKED_BY_HEYGEN_KEY** (also needs broker routes) |
| Tavus adapter | code + tests PASS; live session **BLOCKED_BY_TAVUS_KEY** (also needs broker routes) |
| LiveKit cloud transport | **BLOCKED_BY_LIVEKIT_KEY** — not needed for LiveAvatar (HeyGen supplies `livekit_url`/token) |
