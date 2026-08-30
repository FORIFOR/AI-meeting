# P0-3 — Local turn latency: breakdown + streaming TTS (2026-08-30)

## Result
| speech_end (VAD decision) → first assistant audio | before (`say`) | after (`avspeech` daemon) |
|---|---|---|
| agent-side `firstAudioSentMs` p50 / p95 | **1482 / 2680 ms** | **530 / 558 ms** |
| client-observed (WS) p50 / p95 | 1476 / 2679 ms | 529 / 559 ms |
| + intrinsic VAD end lag (true end of speech → decision) | +432 ms | +432 ms (300 ms setting: +332) |
| ≈ true end of speech → first audio | ≈ 1.9 s | **≈ 0.96 s** (< 1.0 s first target; 700 ms ideal not yet) |
| browser E2E HUD `turn p50/p95` (real Chrome, Live2D, strict_local) | 1670 / 1947 ms (gate7 2nd run) | **1308 / 1547 ms** |

Stage breakdown (4 warm speech turns, `services/agent/scripts/e2e-local.ts`, Silero VAD + SenseVoice + Gemma‑4‑E2B/llama.cpp):
```
stage               before(say) p50/p95   after(avspeech) p50/p95   VAD=300ms p50/p95
vadEndMs                 432 / 432             432 / 432                 332 / 332
sttMs                    101 / 132             133 / 216                 150 / 284
llmTtftMs                164 / 790             151 / 211                 166 / 206
firstPhraseMs            326 / 1014            321 / 367                 278 / 397
ttsTtfaMs               1047 / 1534             53 /  57                  52 /  56
firstAudioSentMs        1482 / 2680            530 / 558                 596 / 734
```
Raw: `services/agent/scripts/e2e-local.result.{before-say,after,vad300}.json` (barge-in 0 ms after speech_start, 0 stale chunks, `/evaluate` overall 85, egress `[]` in every run).

## What changed
- **`tools/tts-daemon/`** (Swift 6, `build.sh` → `bin/rcai-tts-daemon`, git-ignored): resident `AVSpeechSynthesizer` using `write(_:toBufferCallback:)`; stdin JSON lines, stdout binary records `[uint32 id][uint8 kind][uint32 len][payload]` (header / PCM16 / done / error), pre-warmed at start, `cancel` on barge-in. Measured standalone: first audio **≈ 60 ms** after the request, a 4.5 s sentence fully synthesized in ≈ 30 ms wall time (so progressive chunks exist but synthesis is effectively instant — the win is removing the ≈ 0.7–1.0 s `say` spawn+file round trip).
- `services/agent/src/adapters/tts.ts`: `TTSAdapter.synthesizeStream?` (chunks as produced; request issued at call time so the next phrase queues early), `AVSpeechDaemonTTS` + `DaemonRecordParser`, `say`/`sbv2` kept. `server.ts selectTts`: `LOCAL_TTS=auto` (default) → sbv2 (if configured & up) → avspeech daemon (if built) → say.
- `services/agent/src/session.ts`: audio re-framed to 40 ms chunks and sent as TTS chunks arrive (no wait for whole phrase); per-turn `TurnMetrics` (`vadEndMs, sttMs, llmTtftMs, firstPhraseMs, ttsTtfaMs, firstAudioSentMs, totalMs, phrases, sentences, engines, source`) sent as WS `{type:"metrics"}` + `[metrics]` log line; `maxTokens` 120; non-streaming lookahead rejections captured (an aborted queued `say` phrase crashed the agent with an unhandled rejection — fixed + regression test).
- `services/agent/src/sentence.ts`: first chunk of a reply is released at the first clause comma (`そうですね、`, ≥4 chars, never inside `1,000` / Latin), later chunks whole sentences; `endsSentence`.
- `services/agent/src/adapters/vad.ts`: `speech_end.endLagSamples` (Silero: `fed − (seg.start+len)`; energy: hangover) → `vadEndMs`. `config.ts`: `VAD_MIN_SILENCE_MS` (default 400, was 450), `AVSPEECH_VOICE`, `RCAI_TTS_DAEMON`.
- `adapters/llm.ts`: `cache_prompt: true` (llama.cpp KV reuse; system prompt + history prefix stable), default `max_tokens` 120. `--reasoning off -fa on` confirmed in `scripts/local-stack.sh`; the script now builds the daemon when `swiftc` exists.
- `providers/local`: maps `metrics` → `ConversationEvent {type:"metrics"}` (additive). `@rcai/conversation-core`: `TurnMetrics` type + event; runtime forwards and feeds `LatencyTracker.recordBreakdown` / `breakdownSummary()` (additive, `@rcai/audio-core`).
- `scripts/e2e-local.ts`: `E2E_TURNS` warm turns, breakdown table, results JSON. `scripts/e2e-browser.mjs` (agent-scoped copy of the web runner with `AGENT_WS`/`OUT_DIR`).
- Tests: +5 (first-phrase chunker, daemon framing parser, TTS selection fallback, session metrics + streaming order, aborted lookahead). Repo: **23 files / 179 tests pass**, `pnpm -r typecheck` clean.

## Commands
```
tools/tts-daemon/build.sh
scripts/local-stack.sh start                        # llama-server (gemma-4-E2B, --reasoning off -fa on)
PORT=8790 LOCAL_TTS=say      RCAI_EGRESS_LOG=1 pnpm exec tsx src/server.ts ; E2E_TURNS=4 AGENT_URL=http://127.0.0.1:8790 pnpm exec tsx scripts/e2e-local.ts
PORT=8790 LOCAL_TTS=avspeech RCAI_EGRESS_LOG=1 pnpm exec tsx src/server.ts ; E2E_TURNS=4 ... (same) ; VAD_MIN_SILENCE_MS=300 variant
AGENT_WS=ws://localhost:8790 OUT_DIR=docs/reports/img/p0-3 node services/agent/scripts/e2e-browser.mjs <mic.wav>   # web 5173 + broker 8787 already running
```
Browser run (strict_local, Live2D yui, interview persona): pills Connecting→Speaking(opening 213 ms)→Listening→Thinking→Speaking→**Listening (barge-in)**→…; HUD barge-in stop 43 ms, →listening 0 ms, mouth stop 0 ms; captions/STT correct; result 75; agent egress `[]`; screenshots `docs/reports/img/p0-3/`.

## Remaining bottleneck
`true end of speech → first audio ≈ 960 ms = VAD end lag 432 + STT 133 + LLM first phrase 321 + TTS 53 + framing ≈ 20`.
1. VAD end lag (45 %): `VAD_MIN_SILENCE_MS=300` saves ~100 ms (measured, transcripts intact over 4 turns) — default kept at 400 for natural mid-sentence pauses; a semantic end-pointer (partial STT + punctuation) is the real fix.
2. STT (14 %): offline SenseVoice decodes after the segment closes; a streaming recognizer (sherpa-onnx online zipformer, partial results during speech) would make this ≈ 0 at speech end.
3. LLM first phrase (33 %): TTFT 151 ms is fine; the phrase boundary (`、`) comes at ~320 ms. A 1B-class model or speculative decoding lowers it; Gemma‑4‑E2B was the only local GGUF (no downloads > 1 GB by rule).
4. TTS is no longer a bottleneck (53 ms). Style‑Bert‑VITS2 stays **BLOCKED_BY_SBV2_SERVER** (adapter present, selected first when reachable).
Notes: the browser HUD (1308 ms) is higher than agent‑side because it starts at the client VAD's back‑dated true speech end and Chrome/SwiftShader Live2D rendering competes for CPU with STT/LLM on this Mac mini. llama-server was already running (shared with another fork) and was left running; agents on :8790 were stopped.
