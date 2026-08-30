# Gate 6 — Local STT/LLM/TTS conversation (Fork D report, 2026-08-30)

**Status: PASS (executed end-to-end on this machine, strict_local, zero non-loopback egress).**
Non-blocking notes: BLOCKED_BY_SBV2_SERVER (Style-Bert-VITS2 not installed → adapter implemented, falls back to macOS `say`).

## Files
- `services/agent/src/config.ts` — env config, model auto-discovery, loopback checks (`nonLoopbackEndpoints`)
- `services/agent/src/egress.ts` — process-level egress guard (logs every non-loopback `fetch`/`WebSocket`; blocks while a strict_local session is active)
- `services/agent/src/protocol.ts` — WS wire protocol (`[uint32 LE sampleRate][pcm16]`, client 16 kHz pcm16)
- `services/agent/src/sentence.ts` — `SentenceChunker` (TTS starts on the first sentence), `stripMarkdown` (+emoji)
- `services/agent/src/wav.ts` — RIFF parser tolerant of `JUNK`/`FLLR` chunks (macOS `say`), encoder
- `services/agent/src/adapters/{sherpa,stt,vad,llm,tts}.ts` — `SherpaSTT` (SenseVoice / ReazonSpeech zipformer), `WhisperServerSTT`, `SileroVAD` (sherpa-onnx), `EnergyVADAdapter` (fallback), `OpenAICompatibleLLM` (SSE streaming; llama.cpp / Ollama / vLLM / MLX-LM), `SayTTS`, `StyleBertVits2TTS`
- `services/agent/src/session.ts` — `ConversationSession`: VAD → STT → LLM stream → per-sentence TTS (next sentence synthesizes while current streams) → paced audio (≤600 ms client lead) → `assistant_speech_ended`; barge-in aborts everything and emits `interrupted`
- `services/agent/src/planner.ts` — `/plan` via local LLM JSON, heuristic fallback (`@rcai/behavior-engine`)
- `services/agent/src/evaluation-bridge.ts` — `/evaluate` via `@rcai/evaluation.evaluateWithOpenAICompatible` on the local LLM, heuristic fallback
- `services/agent/src/server.ts` — Hono `/health /plan /evaluate /stt /egress` + `ws` `/session` on 127.0.0.1:8788
- `services/agent/src/agent.test.ts`, `services/agent/scripts/e2e-local.ts`, `services/agent/scripts/e2e-local.result.json` (evidence)
- `providers/local/src/{loopback,provider,evaluation,stt,index}.ts`, `providers/local/src/local.test.ts` — `LocalProvider` (RealtimeAIProvider id `local`), `createLocalEvaluationProvider`, `LocalSTTProvider`
- `scripts/local-stack.sh` — start/stop/status for llama-server (+ whisper-server)

## Engines used in the evidence run
| Stage | Engine | Model |
|---|---|---|
| VAD | sherpa-onnx Silero VAD | `reference/silero-vad/src/silero_vad/data/silero_vad.onnx` |
| STT | sherpa-onnx OfflineRecognizer (SenseVoice) | `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx` (auto-discovered; ReazonSpeech zipformer as alternative via `SHERPA_MODEL_DIR`) |
| LLM | llama.cpp `llama-server` (OpenAI-compatible, `--reasoning off`, streaming) | `gemma-4-E2B-it-Q4_K_M.gguf` |
| TTS | macOS `say` (Kyoko, LEI16@24000) | — (SBV2 adapter ready, server absent) |

## Commands run
```
pnpm --filter @rcai/agent typecheck            # Done
pnpm --filter @rcai/provider-local typecheck   # Done
pnpm vitest run providers/local services/agent # 2 files, 18 tests passed
scripts/local-stack.sh start                   # (equivalent: llama-server -m gemma-4-E2B-it-Q4_K_M.gguf --host 127.0.0.1 --port 8080 -c 4096 -ngl 99 --jinja -fa on --reasoning off)
cd services/agent && RCAI_EGRESS_LOG=1 pnpm exec tsx src/server.ts
cd services/agent && pnpm exec tsx scripts/e2e-local.ts   # E2E PASS (3 runs)
```

## E2E results (warm run; `strict_local`)
- `/health`: stt sherpa-onnx ready · llm gemma-4-E2B-it ready · tts macos-say · vad silero-vad
- Turn 1 (say-generated「こんにちは、今日はいい天気ですね」streamed as 16k pcm16):
  - events: user_speech_started → user_speech_ended → user_transcript **「こんにちは、今日はいい天気ですね。」** → assistant_thinking → assistant_speech_started → assistant_transcript「うん、本当に気持ちいい天気だね！」→ assistant_speech_ended
  - audio: 65 chunks @ 24 kHz, 2590 ms
  - **user_speech_ended → first audio chunk: 1067 ms** (cold first run 3511 ms; second run 1148 ms). Breakdown from agent log: STT 83–103 ms · LLM first sentence 296–329 ms · `say` 634–766 ms (fixed process overhead — the bottleneck; SBV2/streaming TTS would cut this).
  - user_speech_ended → transcript: 84–109 ms
- Turn 2 + barge-in (longer answer, then「ちょっと待って」while audio streams):
  - 16 audio chunks streamed before barge-in; **speech_start → `interrupted`: 0 ms** (same tick); audio chunks after `interrupted`: **0** (the 25 chunks that follow belong to the new reply「うん、待ってるね！」, which starts after a fresh assistant_speech_started)
  - bargeSend → interrupted: 802–900 ms = Silero detection + leading silence of the synthetic utterance. The <150 ms product target is met client-side by `ConversationRuntime` (local energy VAD → `sink.interrupt()`), not by the server round trip.
- Text path:「ありがとう、またね」→「うん、またね！元気でね。」1663 ms audio
- `/plan`「すごく良い視点だと思います。」→ `{"emotion":"smile","emotionIntensity":0.8,"gesture":"nod_normal","gestureIntensity":0.7,"energy":0.7,"question":false}` (local LLM JSON)
- `/evaluate` (interview sample, 6.3 s on the local LLM) → overall 85 / clarity 88 / specificity 80 / structure 75 / relevance 90 / fluency 80, 6 Japanese feedback items + improvedAnswer; `evaluatedBy: openai-compatible:gemma-4-E2B-it-Q4_K_M.gguf`
- **Egress log: `{"entries":[]}`** — no non-loopback host was contacted by the agent process during the whole run.

Full JSON: `services/agent/scripts/e2e-local.result.json`.

## Unit tests (18)
protocol framing · sentence chunking (JP terminators, comma break, markdown/emoji strip) · WAV with JUNK chunk · loopback guard + `nonLoopbackEndpoints` · LLM SSE streaming (mock fetch) · SBV2 adapter (`/voice`, wav parse, down → not ready) · whisper-server multipart · EnergyVAD pre-roll · session event order with fake adapters · barge-in aborts LLM/TTS & stops audio · strict_local endpoint rejection · AsyncQueue · LocalProvider connect/audio/event mapping with fake WS · strict_local refuses non-loopback agent · local evaluation + STT providers.

## Blocked / notes
| Key | Detail |
|---|---|
| BLOCKED_BY_SBV2_SERVER | Style-Bert-VITS2 API server not installed; `StyleBertVits2TTS` implemented against `GET /voice` + `/models/info`, selected with `LOCAL_TTS=sbv2`, auto-falls back to `say` with a warning. |
| Latency | P50 ≈ 1.1 s user-end→audio with `say`; the 700 ms target needs a lower-overhead TTS (SBV2 / sherpa-onnx TTS) — STT+LLM alone are ≈ 0.4 s. |
| Whisper path | `WhisperServerSTT` implemented + `local-stack.sh` starts `whisper-server` when `LOCAL_STT=whisper`; not exercised end-to-end (sherpa path was used). |
| Adjacent | `@rcai/evaluation` was present by the time `/evaluate` ran, so the bridge used the real `evaluateWithOpenAICompatible`. |

## How to run
```
scripts/local-stack.sh start          # llama-server on :8080 (LOCAL_STT=whisper also starts whisper-server on :8178)
pnpm --filter @rcai/agent dev         # agent on 127.0.0.1:8788 (env: LOCAL_STT, SHERPA_MODEL_DIR, LOCAL_LLM_URL, LOCAL_TTS, SBV2_URL, SAY_VOICE, RCAI_EGRESS_LOG=1)
cd services/agent && pnpm exec tsx scripts/e2e-local.ts   # evidence script
scripts/local-stack.sh stop
```
Browser side: `new LocalProvider({ agentUrl: "http://127.0.0.1:8788" })`, `createLocalEvaluationProvider({ agentUrl })`, `new LocalSTTProvider({ agentUrl })`.
All background processes started for this report were stopped afterwards.
