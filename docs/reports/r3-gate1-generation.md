# Round 3 — Gate 1: Late chunk elimination via Generation Epoch (2026-08-30)

## Design (implemented)
`GenerationRef { sessionId, turnId, generationId, sequence }` (`packages/conversation-core/src/events.ts`) is stamped by every provider on every assistant-side `ConversationEvent` (`assistant_thinking / assistant_speech_started / assistant_audio / assistant_transcript / assistant_speech_ended / tool_call / metrics`; `interrupted` carries the **cancelled** generation). `GenerationCounter` is the shared helper.

Interruption order (user speech while speaking, tap-to-interrupt, or provider-confirmed `interrupted`):
1. provider cancel — `provider.interrupt()` (OpenAI `response.cancel` + `output_audio_buffer.clear` and the mapper marks the response id cancelled; Gemini `clientContent{turnComplete:false}`; local agent `interrupt` → LLM/TTS abort, generation closed server-side)
2. `acceptedGeneration = current + 1` in `ConversationRuntime` (and, independently, in `AvatarRuntime` and the web caption hook)
3. `sink.interrupt(acceptedGeneration)` — scheduled `AudioBufferSourceNode`s stopped, queue cleared, WebRTC stream gain → 0, and `SpeakerOutput.killedBelow` set so any later `play()` of an older generation is refused (`staleFramesDropped`)
4. pending decoder/playback: late `assistant_audio` events never reach the sink (dropped in `handleProviderEvent` before dispatch)
5. lip sync → `MotionStackAvatarBase.interrupt()` (lip 0, analyser reset) and `pushAudio()` now ignores audio while not SPEAKING, so late tap frames cannot prime the analyser
6. speaking motion → `stack.cut("speech")`, `cut("gesture")`
7. late text/audio/motion/state events of the old generation are DROPPED at three independent layers: runtime (`stats.staleDrops`, `onStaleDrop` hook), avatar runtime (`stats.staleDrops`), web captions (`genRef`)
8. → LISTENING

Provider stamping:
- **local agent** (protocol v2): JSON assistant messages carry `gen: { turnId, generationId, sequence }`; binary audio header is now `[u32 sampleRate][u32 generationId][u32 sequence][pcm16]` (`services/agent/src/protocol.ts`, `AUDIO_HEADER_BYTES = 12`, `ready.protocolVersion = 2`). `interrupt()` aborts, closes the generation (`activeGeneration = 0`) and sends `interrupted{gen: cancelled}`; every later send of that generation is refused server-side (`staleDropsServer`). `providers/local` decodes the header into `GenerationRef` (sessionId is provider-local per connect).
- **OpenAI**: one generation per `response.created` (`response.id` → generationId); after `response.cancel` / `output_audio_buffer.cleared` / `response.done{cancelled}` the response id is in a cancelled set and **every** later raw event with that `response_id` is dropped in the mapper (`mapper.staleDrops`).
- **Gemini**: a generation opens at the first `modelTurn`/`outputTranscription` part after `turnComplete` or `interrupted`; `interrupted` carries the cancelled generation; the delayed `assistant_speech_ended` timer captures its generation at schedule time.
- `ConversationRuntime.switchProvider` resets `acceptedGeneration` (new provider counters).

Contract snippet (docs/integration-contracts.md → services/agent WS, v2):
```
server → binary : [uint32 LE sampleRate][uint32 LE generationId][uint32 LE sequence][Int16LE PCM mono]
server → text   : { type: "assistant_*" | "metrics", ..., gen: { turnId, generationId, sequence } }
                  { type: "interrupted", gen: <cancelled generation> }
                  { type: "ready", ..., protocolVersion: 2 }
```

## Evidence

### 1. Unit / property tests (`pnpm vitest run` → 34 files / 296 tests, all green; scoped typecheck Done)
- `packages/conversation-core/src/generation.test.ts`: 10 late audio/transcript/speech_started events + a late `speech_ended` of an interrupted generation → `staleDrops = 11`, `sink.play` never called, no record turn, state stays `listening`; provider-confirmed `interrupted` bumps the epoch without the fast path; **100-iteration barge-in loop with random late chunks → stale playback 0 / stale caption 0 / stale speaking state 0** (`accepted = 101`, `staleDrops > 100`); provider switch resets the epoch.
- `packages/avatar-core/src/generation.test.ts`: after barge-in, late `assistant_speech_started`/`assistant_audio` of the old generation are dropped (`AvatarRuntime.stats.staleDrops = 2`), state stays LISTENING, `mouthOpenY` stays 0 even when 10 loud frames are pushed through the tap; the next generation starts from a clean analyser.
- `providers/openai/src/openai.test.ts` (+1): one generation per `response.id`; after `markCancelled()` every raw event of that response (delta / buffer.stopped / done) is dropped (`mapper.staleDrops = 3`) and the next response is generation 2.
- `providers/local/src/local.test.ts`, `services/agent/src/agent.test.ts`: protocol v2 header round-trip incl. generationId/sequence.

### 2. 100 consecutive barge-ins against the real local agent (`services/agent/scripts/stress-bargein.ts`, port 8791, strict_local, Silero VAD + incremental SenseVoice + Gemma-4-E2B + AVSpeech daemon; llama-server shared with other forks' soak/e2e runs at the time)
Run 1 (`scripts/stress-bargein.result.run1.json`):

| check | value | PASS |
|---|---|---|
| iterations completed | 95/100 (5 harness timeouts "waiting for quiet", 1 "waiting for interrupted" — see note) | ✗ harness |
| stale audio chunks after `interrupted` (old generationId) | **0** | ✓ |
| stale captions after `interrupted` | **0** | ✓ |
| stale speaking state (`assistant_speech_started` of old gen) | **0** | ✓ |
| stale `assistant_speech_ended` of old gen | **0** | ✓ |
| unstamped assistant messages after interrupt | 0 | ✓ |
| interrupt latency (user_speech_started → `interrupted`) p50 / p95 / max | 0 / 0 / 183 ms | ✓ |
| speech_end → first audio p50 / p95 | 6479 / 7429 ms (agent + llama-server heavily shared during the run; not a Gate 1 metric) | — |
| agent egress (strict_local) | `{"entries": []}` | ✓ |
| server-side `staleDropsServer` (agent log "drop stale") | 0 — abort closes the generation before any late send | ✓ |

Note: the 6 failed iterations were harness sequencing under load (the reply to the *barge-in utterance* legitimately started seconds later and outlived the harness's 15 s quiet window; one barge-in was not detected by VAD within 8 s). No stale chunk was observed in any iteration, failed ones included. The harness now re-cancels on late replies (run 2 below).

Run 2 (harness re-cancels late replies; `scripts/stress-bargein.result.json`):

| check | value | PASS |
|---|---|---|
| iterations completed | 99/100 (iteration 9: the barge-in utterance was not endpointed as speech within 8 s under load — harness timeout, no stale output) | ✗ harness (99 %) |
| stale audio / stale caption / stale speaking state / stale speech_ended | **0 / 0 / 0 / 0** | ✓ |
| interrupt latency p50 / p95 / max | 0 / 0 / 257 ms | ✓ |
| speech_end → first audio p50 / p95 | 6528 / 9087 ms (shared llama-server; see P0-3 report for the unloaded 0.96 s figure) | — |
| egress | `{"entries": []}` | ✓ |

Across both runs: **194 real barge-ins, 0 stale audio chunks, 0 stale captions, 0 stale speaking states, 0 stale speech_ended, 0 server-side stale sends**.

### 3. Browser "stale UI pulse" check (real headless Chrome, fake mic, web :5176 → agent :8792, strict_local)
Runner: `AGENT_WS=ws://localhost:8792 node services/agent/scripts/e2e-browser.mjs mic2.wav http://localhost:5176` (mic: 「こんにちは。今日は面接の練習を…」→ 5 s → 「ちょっと待って、質問があります。」→ 12 s → long answer). Artefacts: `docs/reports/img/r3-gate1/gate7-results.json`, `gate7-session-*.png`.

Before (docs/reports/p0-4-acoustic.md, earlier on 2026-08-30): `… 33392 Speaking → 34117 Listening → 34221 Speaking → 34324 Listening …` — a late audio chunk flipped the pill back to Speaking for ~100 ms after the barge-in.

After (this run):
```
1 Connecting → 1343 Speaking (opening) → 4443 Listening → 8830 Thinking → 10071 Speaking
→ 13421 Listening   ← barge-in during SPEAKING: single clean transition, no Speaking pulse
→ 16140 Thinking → 16450 Speaking → 27811 Idle → 37753 Thinking → 39949 Speaking → 47296 Idle
```
HUD: barge-in stop **43 ms** (n=3), → listening 0 ms (n=3), mouth stop 0 ms (n=3), `stale 0`, errors 0, toasts none; agent egress `[]`. A first run with the barge landing during THINKING (`8830 Thinking → 10071 Listening`) was equally clean.

## Verdict
| Gate 1 criterion | Result |
|---|---|
| stale audio playback | 0 (194 real barge-ins; 100-iteration unit loop; `SpeakerOutput.killedBelow` refuses older frames) |
| stale caption | 0 (runtime drop + `useSession` generation guard) |
| stale speaking state | 0 (runtime + `AvatarRuntime` epochs) |
| stale lip motion | 0 (`pushAudio` ignored while not SPEAKING; analyser reset on interrupt; unit-tested) |
| stale UI pulse | 0 in the browser run; the pre-fix pulse is no longer reproducible |
**PASS** for the staleness criteria. Harness completion 95/100 and 99/100 (timeouts caused by shared-machine load and one undetected barge utterance, never by stale output) is recorded honestly; run the harness on an idle machine for a clean 100/100 line.

## Files
- `packages/conversation-core/src/events.ts` (GenerationRef, GENERATION_EVENT_TYPES, GenerationCounter), `runtime.ts` (epoch gate, `cancelGeneration`, `stats`, `onStaleDrop`, `generation`), `generation.test.ts` (new)
- `packages/audio-core/src/speaker.ts` (`play(frame, { generationId })` → boolean, `interrupt(minGeneration)`, `clearQueue`, `staleFramesDropped`)
- `packages/avatar-core/src/avatarRuntime.ts` (epoch mirror, `stats.staleDrops`), `motionStackAvatar.ts` (`pushAudio` gated by speaking), `generation.test.ts` (new)
- `services/agent/src/protocol.ts` (v2 header, `WireGen`, `PROTOCOL_VERSION`), `session.ts` (generation counters, `sendGen`/`sendAudioGen`, `staleDropsServer`, `interrupted{gen}`), `scripts/stress-bargein.ts` (new), `scripts/stress-bargein.result*.json`, `src/agent.test.ts` (framing test)
- `providers/local/src/provider.ts` (v2 decode → GenerationRef), `local.test.ts`
- `providers/openai/src/events.ts` (response.id → generation, cancelled-response drop, `markCancelled`, `staleDrops`), `provider.ts` (`interrupt()` marks cancelled), `openai.test.ts` (+1 test, shape helper)
- `providers/gemini/src/geminiLiveProvider.ts` (generation per model turn, stamped events)
- `apps/web/src/session/useSession.ts` (caption `gen`/`interrupted`, stale-caption guard)
- `docs/reports/r3-gate1-generation.md`, `docs/reports/img/r3-gate1/*`

## Commands
`pnpm vitest run` → 34 files / 296 tests passed · scoped `pnpm --filter … typecheck` → Done (conversation-core, audio-core, avatar-core, provider-openai/gemini/local, agent) · `scripts/local-stack.sh start` (shared llama-server, left running) · `PORT=8791 pnpm --filter @rcai/agent start` + `AGENT_URL=http://127.0.0.1:8791 ITER=100 pnpm --filter @rcai/agent exec tsx scripts/stress-bargein.ts` (×2) · `PORT=8792 …agent start` + `pnpm --filter @rcai/web exec vite --port 5176` + `services/agent/scripts/e2e-browser.mjs` (×2). Agents 8791/8792 and web 5176 stopped afterwards; no git commits.

Out of scope, noted: `apps/web` and `packages/meeting-core` typecheck currently fail in other forks' in-progress files (`Meeting.tsx`, `IncidentRecorder.test.ts`, `meeting-core/src/lifecycle.ts`); the whole-repo vitest run is green.
