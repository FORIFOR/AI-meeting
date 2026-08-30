# Round 3 — Gate 3 (Streaming STT foundation) · Gate 4 (Adaptive / Semantic endpointing)

Date: 2026-08-30 · Fork P · machine: Mac mini (shared llama-server; other forks ran concurrently — CPU contention noted)

## Verdict
- **Gate 3 PASS (foundation)**: `StreamingSTTProvider` contract (partial / stable / final) in `@rcai/provider-core`; agent adapters `IncrementalOfflineSTT` (SenseVoice re-decoded every 250 ms of new audio, stable prefix, final reused when fresh) and `SherpaOnlineSTT` (true streaming zipformer, generic). Baseline SenseVoice one-shot path kept byte-for-byte (`LOCAL_STT_MODE=baseline`). Nothing engine-specific reaches the Conversation Runtime (still ConversationEvents over the same WS protocol).
- **BLOCKED_BY_NO_JA_STREAMING_MODEL**: the official sherpa-onnx streaming-zipformer list (https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html) has bn/zh/ko/en only — no Japanese; `reazonspeech-k2-v2` on disk is an *offline* transducer. `online` mode falls back to `incremental` with that code.
- **Gate 4 PASS (policy) · KPI target NOT reached**: `EndpointPolicy` (silence × linguistic completeness × stability × adaptive history). Premature endpoints **29.5 % → 15.9 %** (baseline → incremental, same corpus), false continuations 0 %, post-end STT wait **~130 ms → 0 ms** (final reused from the last incremental decode in ≈95 % of turns per agent log). True end → first assistant audio **P50 1011 → 878–939 ms** (two runs; CPU-contended). **P50 < 700 ms not reached** — remaining budget analysis below. Conversation naturalness was not traded away: the policy lowered, not raised, the premature rate.

## Corpus (`tools/endpointing-corpus/`, 44 items, `say -v Kyoko` / Samantha, 16 kHz)
complete 10 · question 5 · mid_pause_particle 8 (clause + 400–600 ms pause + clause, first clause ends in が/ので/て/から/と/は/なら) · mid_pause_filler 5 (えっと/あのー/うーん/なんか/その + pause) · mid_pause_number 4 (dangling numerals/enumeration) · mid_pause_ambiguous 3 (a *complete* sentence, 450–550 ms pause, continuation — deliberately unsolvable from text alone) · english_mix 4 · long 2 · short 3. Ground truth end = last sample > −40 dBFS. Streamed at real time (20 ms frames) into the agent, one WS session per item (`services/agent/scripts/endpointing-eval.ts`).

## Results (endpoint delay = `user_speech_ended` − ground-truth end; KPI = first audio − ground-truth end)
| Config | endpoint delay p50 / p95 (ms) | premature endpoints | false continuation | **KPI true end → first audio p50 / p95 (ms)** | file |
|---|---|---|---|---|---|
| baseline (Silero 400 ms + one-shot SenseVoice) | 551 / 586 | 29.5% (13/44: p01, p04, p06, p08, f01, f02, f03, f05, n02, n04, a02, a03, e03) | 0.0% | **1011** / 1484 | `baseline-run1-2026-08-30T02-06-21-966Z.json` |
| incremental + policy (pause 200 ms) — run 2 | 485 / 766 | 15.9% (7/44: f01, f04, n04, a01, a02, a03, e03) | 0.0% | **878** / 1473 | `incremental-run2-2026-08-30T02-02-22-038Z.json` |
| incremental + policy (pause 200 ms) — run 4 | 508 / 972 | 15.9% (7/44: f01, f04, n04, a01, a02, a03, e03) | 0.0% | **939** / 1435 | `incremental-run4-2026-08-30T02-14-54-128Z.json` |
| incremental + policy, pause 150 ms (experiment, rejected) | 486 / 755 | 20.5% (9/44: c09, f01, f04, n03, n04, a01, a02, a03, e03) | 0.0% | **918** / 1323 | `incremental-pause150-run3-2026-08-30T02-10-52-782Z.json` |

Per tag (baseline → incremental run 2): endpoint delay p50 / premature count, KPI p50
| tag | n | baseline ep p50 / premature | incremental ep p50 / premature | KPI p50 |
|---|---|---|---|---|
| complete | 10 | 550 / 0 | 463 / 0 | 975 → 880 |
| question | 5 | 575 / 0 | 449 / 0 | 1140 → 741 |
| mid_pause_particle | 8 | -1445 / 4 | 503 / 0 | 996 → 870 |
| mid_pause_filler | 5 | -1913 / 4 | 441 / 2 | 1006 → 983 |
| mid_pause_number | 4 | -1227 / 2 | 474 / 1 | 932 → 833 |
| mid_pause_ambiguous | 3 | -1400 / 2 | -1733 / 3 | 1069 → -1390 |
| english_mix | 4 | 502 / 1 | 506 / 1 | 1094 → 901 |
| long | 2 | 560 / 0 | 651 / 0 | 1341 → 1012 |
| short | 3 | 576 / 0 | 733 / 0 | 943 → 1019 |

Stage medians in run 4 (agent `metrics`): LLM TTFT p50 171 ms · first phrase p50 328 ms · TTS TTFA p50 48 ms (n=19). Post-end STT: 0 ms when reused (log `stt=0ms reused=1` on 42/44 pauses in run 2), else 40–130 ms.

## What the remaining premature endpoints are
- **ASR noise on fillers** (f01 「えっと」→「とさ。」, f04 「なんか」→「んか？」): SenseVoice mistranscribes isolated fillers, so the filler rule cannot fire. A streaming recognizer with better filler modelling, or an acoustic filler detector, is the fix.
- **Genuinely ambiguous** (a01–a03: 「昨日は雨でした」+ 500 ms pause; n04 「一つ目は品質。」): a complete sentence followed by a pause — humans also take the floor here. The policy already waits 240–320 ms; the adaptive offset (+80 ms per premature, cap +500) raises it within a session (observed: `need=400` after two prematures) and the merged-text path repairs the turn (「昨日は雨でした 今日は晴れています」 is what the LLM finally sees).
- e03 (English, "…engineer and" + pause): SenseVoice's English partial dropped the trailing "and" ("software eng…") so the conjunction rule could not fire.
Baseline additionally cuts every ≥ 400 ms mid-sentence pause (13/44), including all particle/filler cases that the policy now handles.

## Where the ~880 ms goes (complete sentences) and how to get to 700
| stage | now | note |
|---|---|---|
| Silero segment end vs true end | ≈ 100–200 | Silero keeps speech "on" through the breathy tail; ground truth uses −40 dBFS |
| pause detection (Silero minSilence) | 200 (+~30 lag) | 150 ms tried → premature 20 % (splits inside 「ございます、」) — rejected |
| policy wait beyond the pause | 8–90 | complete+stable 240, complete 320 (needed), unknown 520, incomplete 800, cap 900 |
| post-end STT | **0** (reused) | was ~130 |
| LLM first speakable phrase | ~320 (TTFT ~150) | Gemma-4-E2B via llama.cpp, shared with other forks during the run |
| TTS TTFA | ~55 | AVSpeech daemon |
| framing/pacing | ~20–40 | 40 ms frames |
Next levers (not done here): (1) **speculative LLM start on `soft_endpoint`** — the policy already emits it at ~60 % of the required silence; starting the request then and discarding on resume saves ≈ 60–150 ms (needs the output-side `respond()` to accept a pre-started stream — owned by Fork N this round, documented as future); (2) a true Japanese streaming recognizer (removes the 250 ms decode cadence and improves filler/ending fidelity); (3) an earlier speech-end estimate than Silero's (energy tail detector inside the Silero window).

## Files
- `packages/provider-core/src/streamingStt.ts` (+ index export): `StreamingSTTProvider`, `StreamingTranscript`, `commonPrefix`.
- `packages/conversation-core/src/events.ts`: additive `TurnMetrics` fields (`endpointReason`, `endpointSilenceMs`, `endToFirstAudioMs`, `sttReused`, `sttPartials`, `prematureEndpoint`, `session` rates).
- `services/agent/src/adapters/stt-streaming.ts` (`IncrementalOfflineSTT`), `adapters/sherpa-online.ts` (`SherpaOnlineSTT`), `endpointing.ts` (`assessCompleteness`, `normalizeAsrText`, `EndpointPolicy`), `session.ts` (input side: `onAudioStreaming` / `evaluateEndpoint` / `commitTurn`, premature detection + text merge + history repair), `config.ts` (`LOCAL_STT_MODE`, `PAUSE_MIN_SILENCE_MS`, `STT_INCREMENTAL_INTERVAL_MS`, `ENDPOINT_*_SILENCE_MS`, `SHERPA_ONLINE_MODEL_DIR`), `server.ts` (mode selection + fallbacks, `/health.stt.mode`), `endpointing.test.ts` (36 cases), `scripts/endpointing-eval.ts`.
- `tools/endpointing-corpus/{corpus.json,build.ts}`, `docs/reports/endpointing/*.json`.

## Commands
```
pnpm --filter @rcai/agent exec tsx ../../tools/endpointing-corpus/build.ts        # 44 WAVs
scripts/local-stack.sh start
cd services/agent && PORT=8792 LOCAL_STT_MODE=incremental RCAI_EGRESS_LOG=1 pnpm exec tsx src/server.ts
AGENT_URL=http://127.0.0.1:8792 pnpm --filter @rcai/agent exec tsx scripts/endpointing-eval.ts incremental
PORT=8793 LOCAL_STT_MODE=baseline …  → AGENT_URL=http://127.0.0.1:8793 … baseline
pnpm vitest run services/agent   # 56 passed (incl. Fork N's)   ·   pnpm -r typecheck   ·   pnpm vitest run
```
Egress log under strict_local after every run: `[]`. Agents on 8792/8793 stopped; llama-server left running (shared).

## Heuristics (documented)
Japanese: sentence-final forms (です/ます/でした/ました/ません/ください/でしょうか/かな/よね/ね/よ/か/だ/だった/と思います/んです …) → complete 0.85; questions → 0.8; plain verb/adjective past → 0.65; trailing particles (が/けど/けれど/て/で/し/から/ので/のに/と/や/に/を/は/も/へ/たら/なら/ば/ながら/とか/って/の/、) → 0.15; fillers (えっと/あの/その/うーん/なんか/まあ …) → 0.1 (waits until the 900 ms cap); dangling numerals/enumeration → 0.25; otherwise 0.5. English: terminal . ! ? → 0.95, trailing and/but/so/because/or/then/which/that/to/of/in/with… → 0.15, um/uh/like/well → 0.1. **ASR-appended terminal 。/？ and token spaces are stripped first** (SenseVoice appends them to every segment, including 「ので。」「私は？」); a ？ only nudges an unknown ending to 0.6. Silence required: complete+stable 240, complete 320, unknown 520, incomplete 800, filler/cap 900 (+ adaptive offset: +80 per premature endpoint, cap 500, −20 after 3 clean turns).
