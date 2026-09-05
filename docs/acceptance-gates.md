# Acceptance / Reality Gates — evidence log

Status legend: `PASS` (executed evidence) · `PARTIAL` · `BLOCKED_BY_*` · `TODO`.
Never mark PASS from code existence alone.

| Gate | Status | Evidence |
|---|---|---|
| 0 Repository audit | PASS | `docs/current-state.md` |
| 1 Contracts | PASS | `pnpm test` → 6 files / 43 tests passed; `pnpm -r typecheck` all Done (2026-08-30 04:20). Contracts: `packages/{audio,conversation,provider,avatar,behavior,persona}-core` incl. state machine, MotionStack (6 layers), MotionLibrary (36 clips, no-repeat), AnalyzerLipSync, ProviderRouter + strict_local, ConversationRuntime interruption fast path, BehaviorEngine listening/blink/gaze/planner. |
| 2 Live2D character | PASS | `docs/reports/gate2-live2d.md`: Hiyori/Haru/Mao render in real Chrome (headless), IDLE→LISTENING→THINKING→SPEAKING→INTERRUPTED→LISTENING via unified events; blink/gaze/head motion measured; screenshots `docs/reports/img/gate2-*.png`. Runner: `avatar-providers/live2d/demo/verify.mjs`. |
| 3 Audio-driven lip sync | PASS (analyzer path) / BLOCKED_BY_MOTIONSYNC_CORE (MotionSync path) | Mouth follows PCM from `SpeakerOutput.tap` (max mouthOpenY 0.955), 0 within the same tick on interrupt (`gate2-live2d.md`); real speech in `gate7-web-e2e.md`. `AnalyzerLipSync` unit tests distinguish a/i/u. |
| 4 OpenAI Realtime | CODE+TESTS PASS · device BLOCKED_BY_OPENAI_KEY | `docs/reports/gate4-openai.md`: WebRTC adapter (`/v1/realtime/calls`, ephemeral `client_secrets`), event mapping tests, broker 503 `BLOCKED_BY_OPENAI_KEY` verified live. |
| 5 Gemini Live | CODE+TESTS PASS · device BLOCKED_BY_GEMINI_KEY | `docs/reports/gate5-gemini.md`: WSS BidiGenerateContent adapter, 16k in / 24k out, transcription, interrupted, 8 tests. |
| 6 Local STT/LLM/TTS | PASS | `docs/reports/gate6-local.md`: strict_local E2E on this machine (Silero VAD + SenseVoice + Gemma-4-E2B/llama.cpp + `say`), transcript correct, first audio 1067 ms warm, barge-in 0 stale chunks, egress log `[]`. Browser E2E in `gate7-web-e2e.md`. BLOCKED_BY_SBV2_SERVER for Style-Bert-VITS2 (adapter present, `say` fallback). |
| 7 Behavior engine | PASS (unit + in-browser) | `packages/behavior-engine` tests: blink variance/double blinks, listening nods without repetition, planner async + stale-plan cancel; visible in gate2/gate7 screenshots. 10-minute eyes-on Gate B observation not performed. |
| 8 Personas (free talk / interview / english) | PASS | 13 personas (`personas/`), `gate8-9-personas-evaluation.md`; web app Home/Setup/Session/Result per §19/§20 (`gate7-web.md`, `gate7-web-e2e.md`), no scores during the session. |
| 9 Evaluation sidecar | PASS (local) · cloud BLOCKED_BY_*_KEY | `@rcai/evaluation` heuristic + LLM evaluators (10 tests); local LLM evaluation executed via agent `/evaluate` (overall 85 in gate6, 75 in browser E2E). |
| 10 VRM / realistic | CODE+TESTS PASS · VRM browser render NOT VERIFIED · BLOCKED_BY_HEYGEN_KEY / BLOCKED_BY_TAVUS_KEY | `docs/reports/gate10-vrm-realistic.md`: three-vrm provider (bones/expressions/lookAt/visemes), LiveAvatar (LITE, LiveKit) and Tavus (CVI echo) adapters; broker routes aligned to LiveAvatar API. |

## Whole-repo gate (2026-08-30)
`pnpm -r typecheck` → 20/20 Done · `pnpm test` → 21 files / 121+ tests passed · `pnpm build` → web bundle built · `cargo check` (apps/desktop Tauri shell) → OK.

## Release 0.2.0-beta.1 (Production Beta Candidate, 2026-08-30)
| Item | Status | Evidence |
|---|---|---|
| Release readiness check (`scripts/release/check.mjs --artifacts`) | **Readiness=PASS_WITH_BLOCKED** — version consistency, CHANGELOG/RELEASE, no secrets, typecheck/tests/build/licenses PASS; artifacts present and `codesign --verify` PASS | `RELEASE.md` |
| Signed macOS app + DMG | PASS (Developer ID) · launched once: process ran, window rendered | `apps/desktop/src-tauri/target/release/bundle/{macos,dmg}` |
| Notarization / Gatekeeper | **BLOCKED_BY_APPLE_NOTARY_CREDS** (`spctl` rejected) | |
| Auto-update | **BLOCKED_BY_UPDATE_ENDPOINT** (plugin not wired; no channel) | |
| Distribution / remote | **NOT_PERFORMED** — no git remote; pushing/creating a repo is a human decision | `git tag v0.2.0-beta.1` |
| Manual GUI smoke | ManualSmoke=NOT_RUN_BY_ASSISTANT (headless evidence only; no mic on the build host) | |

## Production Reality Gate — Round 3 (Beta Candidate quality, 2026-08-30)
| Gate | Status | Evidence |
|---|---|---|
| 1 Late-chunk elimination (Generation Epoch: sessionId/turnId/generationId/sequence, 3-layer stale drop, local protocol v2) | **PASS** — 194 real barge-ins: stale audio 0 / caption 0 / speaking state 0 / speech_ended 0 / server stale sends 0; browser: single Speaking→Listening transition (pulse gone), barge-in stop 43 ms | `docs/reports/r3-gate1-generation.md`, `services/agent/scripts/stress-bargein.ts`, `packages/conversation-core/src/generation.test.ts` (100-iteration loop) |
| 2 AudioWorklet lifecycle | **PASS** — root cause (StrictMode double-mount closing the context mid-`addModule`) fixed; 100× mount/unmount/route: uncaught 0, console errors 0, leaked AudioContext 0, leaked tracks 0 | `docs/reports/r3-gate2-lifecycle.md`, `docs/audio-lifecycle.md`, `apps/web/scripts/lifecycle-stress.mjs` |
| 3 Streaming STT foundation | **PASS (foundation)** — `StreamingSTTProvider` (partial/stable/final), `IncrementalOfflineSTT` (post-end STT wait 130 → 0 ms on 42/44), baseline kept; online zipformer adapter present but **BLOCKED_BY_NO_JA_STREAMING_MODEL** | `docs/reports/r3-gate3-4-stt-endpointing.md` |
| 4 Adaptive / semantic endpointing | **PASS (policy)** · KPI 700 ms **NOT reached**: true end → first audio p50 1011 → **878 ms**, premature endpoint 29.5 % → **15.9 %**, false continuation 0 %; 150 ms pause variant rejected (premature ↑) | same report, 44-item corpus, `services/agent/scripts/endpointing-eval.ts` |
| 5 Meeting security / lifecycle | **PASS (code + real-socket smoke)** — HMAC signed single-use bot-page tokens (exp/binding/replay/revoke/cleanup), lifecycle 14 scenarios; live Meet **BLOCKED_BY_RECALL_KEY** | `docs/reports/r3-gate5-meeting.md`, `services/token-broker/scripts/smoke-meeting-security.ts` |
| 6 Presence incident instrumentation | **PASS (executed)** — ±5 s incident (transcript/events/state/motion/emotion/gaze/VAD/latency/provider/errors), audio/video opt-in only | `docs/reports/r3-gate6-7-observability.md` |
| 7 Production observability | **PASS** — per-session report (provider, turns, latency histogram, reconnects, interruptions, stale drops, STT/TTFT/TTFA, lip delay/frame, meeting state); strict_local ⇒ no telemetry send | `packages/observability`, `docs/observability.md` |
| 8 External Reality Gate harness | **PASS** — `pnpm reality:{openai,gemini,local,meet,zoom,human}`; missing credential ⇒ `BLOCKED_BY_*` + exit 2 (verified) | `scripts/reality/*.mjs` |
| `pnpm reality:local` (10 min, strict_local, built app) | **PASS** — survived 10.0 min, 61 assistant turns (100 % of heard utterances answered), turn p50/p95 **1702 / 3139 ms** (n=64, shared-CPU run), barge-in stop 43 ms (n=42), mouth stop 1 ms, 0 toasts/console/page/http errors, 1 stale chunk **dropped** (0 played), egress `[]` | `docs/reports/soak/local-2026-08-30T02-45-14.md` (soak HUD parser fixed afterwards; `LatencyTracker` sanity cap added so a dangling mark can no longer produce a 10 s outlier) |
Whole-repo gate: `pnpm -r typecheck` clean · `pnpm test` **34 files / 296 tests** · `pnpm build` OK · strict_local egress `[]` in every run.

## Production Reality Gate (round 2, 2026-08-30)
| Item | Status | Evidence |
|---|---|---|
| P0-1 Google Meet / Zoom participation (`MeetingConnector` + `RecallConnector` + `ParticipationPolicy`) | CODE+TESTS PASS · real Meet **BLOCKED_BY_RECALL_KEY** (+ `RECALL_PUBLIC_URL` tunnel) | `docs/reports/p0-1-meeting.md`; 25 policy/detector tests, 9 connector tests, broker relay ws + 503 smoke; harness `pnpm --filter @rcai/connector-recall e2e:meet` exits 2 with the BLOCKED code |
| P0-2 OpenAI / Gemini 30-min real-API soak | harness PASS on Local (10 min: 53 turns, 98 % answered, 0 errors) · **BLOCKED_BY_OPENAI_KEY / BLOCKED_BY_GEMINI_KEY** for cloud | `docs/reports/p0-2-cloud-soak.md`, `docs/reports/soak/*`; reconnect logic + 7 tests in both providers |
| P0-3 Local latency breakdown + streaming TTS | **PASS (first target)**: true speech end → first audio ≈ **0.96 s** (was ≈ 1.9 s); agent firstAudioSent p50 **530 ms** (was 1482); browser HUD turn p50 **1308 ms** (was 1670) | `docs/reports/p0-3-local-latency.md`; breakdown vadEnd 432 · STT 133 · LLM TTFT 151 · first phrase 321 · TTS TTFA 53 (AVSpeech resident daemon `tools/tts-daemon`, phrase-level chunking); 700 ms ideal not yet (VAD end lag + offline STT next) |
| P0-4 Real-device acoustic gate | **PASS (loopback worst case)**: 0 self-triggers, barge-in 272 ms end-to-end / 43 ms audio stop · **BLOCKED_BY_NO_MIC_DEVICE** for AirPods/built-in mic (Mac mini has no mic) | `docs/reports/p0-4-acoustic.md`, runner `apps/web/scripts/acoustic-gate.mjs` |
| P1 Human 10-min gate tooling | tooling PASS · human sessions **NOT RUN** | `docs/human-gate.md`, `HumanGatePanel`, `/api/feedback` → `docs/reports/human/*.jsonl` |
| P1 Listener Semantics | PASS (unit) | 「失敗してしまって」→ concerned, never smile; achievement → warm nod; hesitation → head tilt (`packages/behavior-engine/src/listenerSemantics.ts`) |
| P1 Evidence-based evaluation | PASS (heuristic, verbatim quotes validated) · LLM path BLOCKED_BY_*_KEY | `services/evaluation/src/evidence*.ts`, Result screen criteria cards |
| P1 MotionSync A/B + 50–200 sentence corpus | MotionSync path implemented end-to-end (TS port of CubismWebMotionSyncComponents + `kei` sample with motionsync3) · **BLOCKED_BY_MOTIONSYNC_CORE** for the A/B · Analyzer measured on **192 corpus runs** in real Chrome: vowel-shape differentiation 0.03 → **0.69**, coverage 89 → **96 %**, 小声 max-open 0.25 → 0.97, interrupt 0.97 → 0 in 0.2 ms | `docs/reports/p1-lipsync.md`, `docs/reports/lipsync/*`, `tools/lipsync-corpus/` (60+ sentences × 3 variants) |
| Licenses / NOTICE | PASS | `pnpm licenses` → `licenses.json`, `THIRD_PARTY_NOTICES.md`, curated `NOTICE.md` (Live2D/models/voices/services); no copyleft-only deps |
| Desktop packaging | macOS `.app` built and **signed** (Developer ID Application, `codesign --verify --deep --strict` OK, mic/camera usage strings + entitlements) · notarization **BLOCKED_BY_APPLE_NOTARY_CREDS** · auto-update **TODO** (no updater endpoint) · Windows **BLOCKED_BY_WINDOWS_BUILD_HOST** | `pnpm --filter @rcai/desktop exec tauri build --bundles app` → `apps/desktop/src-tauri/target/release/bundle/macos/Realtime Character AI.app` (28 MB) |

## Independent review (Codex, read-only) — 9 findings, all fixed 2026-08-30
| # | Finding | Fix |
|---|---|---|
| 1 high | strict_local still loaded Cubism Core from the CDN | `resolveCoreUrl({ allowCdn:false })` under strict → `BLOCKED_BY_LIVE2D_CORE_OFFLINE` unless vendored; `scripts/fetch-live2d-core.sh` + `apps/web/public/vendor` symlink |
| 2 high | cloud avatars selectable under strict | registry/SessionController refuse `liveavatar`/`tavus` (`BLOCKED_BY_STRICT_LOCAL`), Setup disables them |
| 3 high | health probe hit a non-loopback agentUrl under strict | `isLoopbackUrl` gate in `apps/web/src/api/health.ts` |
| 4 high | WebRTC (OpenAI) stream not muted on local interrupt | `SpeakerOutput.interrupt()` mutes the stream gain; runtime calls `resumeStream()` on next `assistant_speech_started` |
| 5 high | agent `stop` + ws `close` double-decremented the strict egress counter | `Session.stop()` idempotent |
| 6 med | opening line sent twice (controller + provider) | providers own it (OpenAI `response.create`, agent TTS, Gemini client turn); controller no longer sends |
| 7 med | VAD never learned steady loud background | floor adapts slowly while loud (test added) |
| 8 med | downsampling without anti-alias | 2× biquad LPF at 0.45·target before decimation (test added) |
| 9 med | composed params not clamped | `clampParams` on every compose |
Re-verified after fixes: `pnpm gate` (typecheck 20/20, 124 tests, build) and the browser E2E (`gate7-web-e2e.md`, second run: turn p50 1670 ms, barge-in 43 ms ×2, egress `[]`).

## Blocked items
| Key | Meaning | How to unblock |
|---|---|---|
| BLOCKED_BY_MOTIONSYNC_CORE | Live2D MotionSync Core not available (not on GitHub/CDN) | download MotionSync Plugin for Web → `vendor/live2d/live2dcubismmotionsynccore.min.js` |
| BLOCKED_BY_RECALL_KEY / BLOCKED_BY_RECALL_PUBLIC_URL | Recall.ai API key + public tunnel URL for the realtime relay / bot page | `services/token-broker/.env` (`RECALL_API_KEY`, `RECALL_REGION`, `RECALL_PUBLIC_URL`, `RECALL_BOT_PAGE_URL` via ngrok/cloudflared) |
| BLOCKED_BY_NO_MIC_DEVICE | this Mac mini has no microphone | run `apps/web/scripts/acoustic-gate.mjs` / `docs/human-gate.md` on a laptop |
| BLOCKED_BY_APPLE_NOTARY_CREDS | notarization credentials absent | `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` |
| BLOCKED_BY_NO_JA_STREAMING_MODEL | no Japanese streaming (online) zipformer in the official sherpa-onnx list | provide a Japanese streaming model dir → `LOCAL_STT_MODE=online` (`SHERPA_ONLINE_MODEL_DIR`) |
| BLOCKED_BY_LIVE2D_CORE_OFFLINE | strict_local + no vendored Cubism Core | `scripts/fetch-live2d-core.sh` (official CDN → `vendor/live2d/`, git-ignored) |
| BLOCKED_BY_OPENAI_KEY | no `OPENAI_API_KEY` | set in `services/token-broker/.env` |
| BLOCKED_BY_GEMINI_KEY | no `GEMINI_API_KEY` | set in `services/token-broker/.env` |
| BLOCKED_BY_GEMINI_FREE_TIER | the key on file is free tier: 15 req/min and 500/day on flash-lite, 20/day on flash; the hybrid engine's three-step hedge spends up to 3 per turn (soaks 19–21, `docs/commercial-gate.md` § The model's quota) | a billed Gemini key, or `LOCAL_LLM_*` on the local model |
| BLOCKED_BY_HEYGEN_KEY / BLOCKED_BY_TAVUS_KEY / BLOCKED_BY_LIVEKIT_KEY | realistic avatar credentials | set in `services/token-broker/.env` |
| BLOCKED_BY_SBV2_SERVER | Style-Bert-VITS2 server not installed | run SBV2 API server, set `LOCAL_TTS=sbv2` |
| LATENCY_TARGET_NOT_MET (local) | turn p50 2.2 s vs 700 ms target — macOS `say` adds ~0.7 s, Gemma-4-E2B on this Mac ~0.3 s/first sentence | faster TTS (SBV2 / sherpa-onnx TTS), smaller LLM or cloud engine; STT+LLM alone ≈ 0.4 s |

## Reality gate checklists (spec §28)
- Gate A Conversation (10 min): no drop · no premature interruption · barge-in works · Japanese stays short · provider switch works
- Gate B Character (10 min): never mouth-only · never frozen while listening · natural blink · no repeated nod · head/eyes/body move · mouth stops at speech end
- Gate C LipSync (50 JP sentences): あいうえお · numbers · English words · names · long · fast · questions
- Gate D Provider: same persona on OpenAI / Google / Local with unchanged character UI

## Cloud reality gates (2026-09-01)

| Gate | Verdict | Evidence |
|---|---|---|
| OpenAI Realtime, 30-minute soak | **PASS** | `docs/reports/soak/openai-2026-09-01T00-25-47.json` — survived 30.0 min, 199 assistant turns, 100 % answered, turn latency p50 1495 ms / p95 1948 ms (n=207), barge-in → audio stop 43 ms (n=123), 0 toasts / 0 page errors |
| Gemini Live, 30-minute soak | **PASS** | `docs/reports/soak/google-2026-09-01T01-34-39.json` — survived 30.0 min, 151 assistant turns, 100 % answered, turn latency p50 3985 ms / p95 8929 ms (n=149), one `goAway` rotation at 542 s reconnected and the conversation continued to 1798 s |

Both were driven by `scripts/reality/cloud.mjs` against the real APIs with a synthesised microphone —
no human in the loop.

### What the real APIs exposed that mocks never would

- `response.cancel` with nothing in flight ends an OpenAI session; `speakingResponse` was also never
  released, so after the first reply the provider believed a response was open forever.
- An ephemeral Gemini token is only accepted on `BidiGenerateContentConstrained`. The socket **opens**
  with any credential — Google authenticates on the first frame — so every "it connected" check passed
  against an endpoint that could never work.
- A token's `bidiGenerateContentSetup` is used **instead of** the client setup, silently dropping
  `inputAudioTranscription`: the model answered but no user speech was ever transcribed.
- Native-audio models emit reasoning as `thought` text parts, which went straight into the captions.

### Open

- **Gemini latency**: p50 3985 ms against OpenAI's 1495 ms. Not investigated.
- **OpenAI credits are exhausted** (`credit_balance_exhausted`), which is what made `/api/evaluate`
  return 502 at the end of both runs. Quota is now reported as `BLOCKED_BY_OPENAI_QUOTA` (503) rather
  than a generic upstream failure; the result screen still falls back to the heuristic evaluator.
- **Mishearings that read as words** (run 75): 「ゆい英坊を思う？」 was answered about a colleague called 英坊, and no prompt rule fixed it with the 2B model (`meeting-garble.json`). The policy now refuses a two-character "question" that is not a question word (「とれ？」), the sound-alike vocative needs words after it (「い？」), a yield (「ちょっと待って、先に…」) is answered in a word and a two-character line is asked back — but a garbled name+question still gets a confident answer. Lever: the recogniser (whisper rescore of the addressed line, or Meet's own captions as a second opinion).
- **Open-mic rooms** (run 71, sim 47): the character listens to the vendor's *mixed* stream, so another
  participant's open microphone overlapping a question destroys the question (「マイナンバーというの大体の今日の予定を教えて」)
  and cuts the answer as a barge-in. Attribution by loudness stops the chatter from earning turns; surviving
  the room itself needs the recogniser fed per participant with the mix as fallback, and a barge-in that asks
  who is talking. Not started.

### Meeting: address → answer

`pnpm reality:address` — **PASS**, no meeting and no bot required. The real `ParticipationPolicy` is fed
real transcript segments and whatever it decides runs through the real agent:

| step | result |
|---|---|
| address detection (7 lines, 3 addressed) | 7/7 classified correctly |
| answered when addressed | 3/3 |
| spoke | 10.3 s @ 22050 Hz, peak 34 % |
| stayed quiet otherwise | 3 replies for 3 addresses |

```
✓ [ignored ] では、今日の議題を確認しましょう。
✓ [answered] ゆいさん、聞こえていますか。            → はい、聞こえています。 (1807 ms)
✓ [answered] ゆいさん、今日の会議の進め方は？        → 今日の進め方は効率的だと思います。 (3718 ms)
✓ [ignored ] ゆいがそう言ってた気がする。             ← third-person mention, correctly ignored
✓ [answered] ゆいさん、来週までにやることを？        → 来週までに、資料の最終確認と…
```

The first attempt failed 2 of 3 addresses, and the policy was right: it does not answer twice in a row
without someone else speaking (`maxConsecutiveResponses`) and holds a cooldown after answering. A script
that talks the way a meeting does passes.

**Not covered**: Recall's own delivery of those segments in a live call, which needs a bot, which needs
credit on the workspace (see below).

### Meeting: what the character says (2026-09-03)

`pnpm reality:conversation` with a meeting scenario — the real agent, the real LLM (gemini-3.5-flash-lite,
hedged) and TTS, the persona and meeting instructions built from the same sources the bot page uses, each
line the room addressing the character with the lines before it (`meetingTurnPrompt`), the arrival turn
rendered by `meetingGreetingPrompt`. Scored by named checks per turn; the full account, before/after
tables and the prompt lessons are in `docs/commercial-gate.md` (「In a meeting, on the gate's own script」).

| scenario | checks | latest | evidence |
|---|---|---|---|
| `meeting-gate.json` — the attendee-auto cue script in text: greeting, 「ゆイ、今日の予定を教えて」, 「これはどう思う？」 after a third-person mention, 「今どう思う？」 after a cut-in | own name + how to call it, no invented schedule, honest or asks, demonstrative resolved to 三ページ目の数字, no parroted name, names as written, substance | **PASS 15 / 15** ×3 (12 / 12 ×2 before the names check, 8 / 8 ×6 before the greeting turn) | `docs/reports/conversation/meeting_colleague_ja-2026-09-03T10-33-59.json` (gate script, with the "not just I don't know" rule), `…T10-17-19.json` before it; standup `…T10-31-28.json`, `…T10-32-51.json`; earlier runs `…T09-4*` … `…T10-1*` |
| `meeting-garble.json` — the lines run 75's recogniser actually produced: 「ゆい英坊を思う？」(どう思う), 「とれ？」 as an engaged follow-up, 「ちょっと待って、その前にこっちの話日を先に咲いて印刷しと。」 and 「…こっちのア日ーを済みさせて。」 (両方 「先にさせて」) | no invented person, asks back and briefly on a two-character line, yields in ≤ 40 chars with no opinion and none of the garbled words | **yield 6 / 6 and 6 / 6** (「はい、どうぞ。」 0.5–0.9 s; before the turn hint: 「すぐにこちらの話の日程を印刷しておきますね」 6.6 s, 「相手の方の作業が終わるまで…」), **short line asks back 6 / 6** (「はい、何でしょうか？」; before: the previous question answered again, 11 s) · 「ゆい英坊を思う？」 **not fixed**: no rule wording beat the no-rule baseline (quoting the garble 2 / 6, 「ゆい英坊さん」 1 / 6) — left to the recogniser | `docs/reports/conversation/meeting_colleague_ja-2026-09-04T04-26-17.json`, `…T04-26-38.json`, `…T04-27-00.json`; gate script after the change 15 / 15 ×3 `…T04-27-46.json`, `…T04-28-26.json`, `…T04-28-59.json` |
| `meeting-standup.json` — schedule question, data doubt, release-date change to summarise, opinion, memory callback, next-week tasks, hand-off | no invented schedule or tasks, grounded in the room, new date 17 with the reason, opinion with a reason, remembers the date, steps back without a question | **PASS 16 / 16** ×4 (15 / 15, 13 / 13 ×5) | same directory |
| `pnpm reality:address` with the shipped persona + prompt | 7 / 7 addresses classified, 3 / 3 answered, quiet otherwise; replies honest about tasks it does not have | **PASS** (2 runs) | run output; audio wav in the run's temp dir |

Model-side conditions measured on the way: replies bounded by `HedgedLLM` (first token p50 0.96 s, worst 4.3 s
over 48 turns; unhedged worst had been 17.3 s), the meeting persona `meeting_colleague_ja` (questions back on
1 of 6 turns instead of 6 of 6), one register for the whole meeting. The last rule added (「知らないと言って終わりにしない」)
turned 「来週までのやることは手元にないので、確認してもいいですか？」 into 「私の来週の担当タスクは手元にありませんが、会議では
十七日のリリースに向けた不具合修正や、チームへのスケジュール変更の共有が進められることになっていますね」 — the same honesty,
with what the room decided in it — at the cost of longer turns (standup replies 6–14 s of audio, 3–10 s before).

**Not covered**: the same replies through a real microphone and Meet's noise suppression, and the
recogniser's spelling of a question under host load — that is Gate #8 (Runs 17–28 in
`docs/commercial-gate.md`: `DEGRADED_BY_HOST_CPU` / `BLOCKED_BY_NO_ADMITTER`; Run 29 launched 2026-09-03 19:41 JST with everything above in place and was `BLOCKED_BY_NO_ADMITTER` — nobody in the room; Run 30 (20:29 JST) was the same on the native arm64 Attendee image — VM load 1.0–2.4 instead of 18–24, both bots knocking within 30 s — and again `BLOCKED_BY_NO_ADMITTER`; Runs 31–40 kept a knock alive 20:42–22:37 JST with the same result. The next run is that configuration with a person in the room, or with the room's access set to open). Runs 44–47 (2026-09-03/04, admitted) went 6/7 → 6/7 → 5/7 → **7/7** with the avatar rendering; Run 63 (2026-09-04 08:05 JST, first admitted run on whisper-async + int8 Supertonic + Meet captions) 6/7 with `bargein` PARTIAL and Meet's own captions read for the first time — its two unconfirmed cuts traced to the bot page's runtime energy VAD, now disabled on the bot page (`MeetingSessionController`, 2 tests); details and meeting latencies in `docs/commercial-gate.md` run 63. Runs 69–71 (2026-09-04 09:36–10:24 JST, admitted, eight-cue script with `followup`) went 3/8 → 6/8 → 6/8: 69 `DEGRADED_BY_HOST_CPU` (the character heard 0–0.9 s of each cue), 70 traced its one lost question to zero-fill inside Attendee's realtime capture, 71 was `DEGRADED_BY_OPEN_MIC` — the admitter's microphone carried a television, one line of which the character answered as an engaged follow-up. That last failure is fixed by attributing each utterance to the participant whose own stream was loudest over the utterance (`speech_level` events from `AttendeeConnector`, `MeetingSessionController.attribute`, 3 tests) and reproduced offline in sim 47 (`attendee-sim.mjs NOISE=…`, run 71's chatter as a second participant): no chatter earns a turn any more, but a question the chatter overlaps is still lost inside the vendor's mix and answers are still cut by it — open item below. Runs 72–74 were `BLOCKED_BY_NO_ADMITTER`; the harness now keeps the room between passes (`KEEP_ROOM=1`, `rerun`/`stop` files) so one admission carries the whole gate. Run 75 (12:25–12:59 JST, one admission, four passes) found the ears' holes to be **memory** — six Chromium+chromedriver pairs leaked from expired knocks had the Attendee VM in swap; after the admitter killed them the holes stopped and passes 3–4 answered every question in full (`DEGRADED_BY_HOST_MEMORY`; pre-flight now counts Chromium in the worker). The Tester bot's own capture went to digital silence at 12:44:58 JST, so its audibility verdicts from then on are void — the admitter heard the character, the Tester did not; details in `docs/commercial-gate.md` run 75. Run 76 (13:57 JST) was `BLOCKED_BY_BOT_HOST` — the Tester's launch sat 2 m 44 s in a worker with 70 leaked Xvfb; the worker was restarted. Run 77 (14:06 JST, admitted in 28 s, one pass) went **4/8 with the host's memory fine**: 139 holes / 87.6 s in five minutes on the vendor's own timestamps, ask1 reaching the recogniser as 4.14 s with 1.48 s of exact zeros inside — memory was a cause, not the cause. The yield fix held in the room (「ちょっと待って、その前に…」 → 「はい、どうぞ。」 1.73 s). The broker's relay now keeps the last 64 holes with arrival times and counts all-zero chunks before the tunnel (`RelayHub`, 1 test), the harness prints them per pass against the cue schedule; the next knock runs with the character's own 1080p30 screen recording off and the page at 15 fps — run 75's launch line, which run 77 had dropped (the one difference found between run 75's clean passes and run 77). Run 78 (15:50–16:20 JST, admitted in 55 s, four passes on that launch line) confirmed it: **37 holes / 15.2 s in 30 minutes** against run 77's 139 / 87.6 s in five, no answer lost to zeros, passes 7/8 · 7/7 · 5/7 · 7/7 with `bargein` PASS ×4. The two real failures are the recogniser's: pass 3 `third` heard 「ユが昨日そう言ってたよね。」 (name dropped → engaged follow-up → answered) while the whisper rescore read 「ユイが…」 1.9 s later, and pass 3 `ask2` lost the question in a 0.3 s hole (「ゆいいいと思う。」). Pass 1's `chat` FAIL was the greeting's own `turn` event, scored (harness fixed). Turn → audible ≈ 6–7 s. Next: a second-opinion from the rescore at the policy (withdraw a follow-up turn the better reading contradicts), then re-knock on run 78's launch line. Run 79 (16:43 JST, admitted, one pass) went **6/8 with the vendor → broker ears row PASS for the first time** (3 holes / 1.5 s): `ask1` was lost the other way round — the streaming recogniser wrote 「唯イ寮の予定を教えて。」 (no known spelling → no turn) and the whisper rescore read 「ゆい、今日の予定を教えて」 1.2 s later. Both directions are one mechanism now — the rescore is a second opinion on the same utterance: it withdraws an engaged follow-up its better reading contradicts, and earns a late turn for an address its first reading missed (`ParticipationPolicy.withdraw`/`detect`, `MeetingSessionController.secondOpinion`, 7 + 1 tests; 唯 / 結衣 added to Yui's aliases). Runs 80 and 82 were `BLOCKED_BY_NO_ADMITTER`. Run 81 (17:56 JST, admitted in 31 s, two passes) went **7/8 then 0/5**: pass 1's only miss was `bargein` PARTIAL by timing (a 6.6 s reply had ended by the time the cut-in reached the recogniser, nothing to stop); pass 2 found a new failure class — **the page ↔ agent WebSocket closed 40 s into the pass, silently on both sides, and the character sat with working ears and no brain through four questions** (the cues reached the broker as sound; `lsof` showed no connection to :8788 left). Fixed in `MeetingSessionController`: an unasked-for `session_closed` gives up the turn in flight and brings a new provider up behind the same avatar and speaker (`runtime.switchProvider`, 1 → 30 s backoff until the page leaves; `agent_closed` / `agent_reconnected` reported; 4 tests). The cause of the close is not known (quick-tunnel WebSocket reset is the leading guess); the reconnect has not yet been seen to fire in a room. Ears with run 78's launch line: 3–4 holes per pass, each ≤ 0.9 s, the vendor → broker row PASS in runs 79 and 81. Next: re-knock on the same launch line with the reconnect in place, several passes on one admission. Run 83 (05 Sep 01:18 JST, admitted in 37 s, two passes) went **8/8 then 3/8**: the first clean eight-cue pass in a real room (`bargein` PASS, ears 2 holes / 0.8 s, vendor → broker row PASS), then `DEGRADED_BY_VENDOR_AUTO_LEAVE` — Attendee took Yui out of the room with `auto_leave_silence` exactly 1800 s after she joined (its recorder default: 600 s without a non-zero audio frame once 1200 s in), five seconds before pass 2 began, so pass 2's questions played to a room without her. Fixed at the join: `automatic_leave_settings.silence_timeout_seconds: 3600`, overridable per join (`automaticLeave`, 2 tests); `session_closed` now carries the WebSocket close code so run 81's class of failure will name itself. The reconnect has still not been seen to fire in a room. Next: re-knock with the broker on the new join payload, passes triggered promptly on one admission. Run 84 (05 Sep, on the new join payload, stored `silence_timeout_seconds: 3600` confirmed on the bot): **one admission, four passes, every cue PASS** — 8 / 8, 7 / 7, 7 / 7, 7 / 7 over 21 minutes, `bargein` ×4, no vendor leave, no `agent_closed`. What degraded was the bot host under sustained load: greeting 13.5 s, the ears' holes growing pass over pass (2.1 s → 9.0 s cumulative), reply gaps up to 4.3 s so pass 4's answers came after their windows (`DEGRADED_BY_HOST_CPU`, unchanged). A character-quality defect surfaced: the second-pass recogniser hallucinated names on sub-second fragments (「見たよ。」 → 「メタリオ」, three runs), and they reached the reply through the recent-utterance context (「メタリオさんが直前に…」) — a rescore guard is the next agent fix. The harness now re-knocks on an unadmitted-and-dropped knock so bots can be parked at the door ahead of the tester (unverified in a room). Runs 85–86 (05 Sep 02:43–04:45 JST) verified the parking: six knocks each, worker restarted between them, nobody in the room (`BLOCKED_BY_NO_ADMITTER`). Run 87 crashed at the knock (`HeadersTimeoutError`): the Docker VM had stalled on a full host disk — `BLOCKED_BY_BOT_HOST`, harness `state()` now times out instead of throwing. Run 88 (05 Sep 07:45–08:06 JST, admitted in 27 s, four passes, agent on the rescore guard) went **8/8 → 4/7 → 5/7 → 3/7** and surfaced two failure classes: (1) the page ↔ agent reconnect fired in a room for the first time (1006 → new provider in 1.9 s) and the pass behind it answered, but for two and a half minutes the page's speech never reached the Tester (three PARTIAL cues, no trace in the vendor's logs — **unexplained**); (2) at 22:59 Z the bot page reloaded itself and the character was deaf and mute for the rest of the admission — traced over DevTools in the streamer's Chromium to the **Vite dev client's reload after its HMR socket dropped** on the quick tunnel (the single-use activation token cannot be replayed). Fixed: the bot page is the built app on `vite preview --port 5180`, `meet-setup.sh` prefers it, and the harness pre-flight refuses a page carrying `/@vite/client` (`BLOCKED_BY_DEV_BOT_PAGE`); the built page passed the offline sim in bot mode (sim 50). Ears (vendor → broker) PASS; 「3ページ目」 → 「3定リ目」 is the run's recogniser finding. Next: re-knock on the built page, several passes on one admission, and watch for the inaudible stretch. Run 89 (05 Sep 10:43–11:04 JST, admitted in 31 s, four passes on the built bot page) went **8/8 · 7/7 · 7/7 · 7/7 — every cue PASS**, `bargein` ×4, no page reload, no `agent_closed`, no vendor leave, greeting 7.4 s, ears (vendor → broker) PASS with 6 holes / 2.0 s in 21 minutes, vendor transcript 24/63 by Yui. Run 88's inaudible stretch did not recur (still unexplained). What remains is sound quality under host load (`ask2` stretched ×1.46–1.48 with 2.6 s gaps, muffled f99 ≈ 1.9 kHz on two replies) and turn → audible 5–7 s. Next: the same launch line is the reference; work moves to reply latency and the audio gaps.

### Recall credits exhausted

`insufficient_credit_balance` — the $5 free grant is spent (2-core 0.92 h, GPU 2.97 h). The GPU hours are
the `web_gpu` variant Live2D requires at $1.50/h, spent during this session's debugging. `pnpm
reality:meet:live` is written and ready: it sends the character in and a second Recall bot that speaks
synthesised Japanese through Output Audio, so the live hop needs credit, not a person.

### Meeting: address → answer (superseded)

The character only speaks when it hears its name, and in a meeting that name arrives on Recall's in-bot
transcript socket, which exists only inside a bot. To make the path exercisable — and because a single
transcript source is a single point of failure for the one thing that makes the character speak — the bot
page now also subscribes to the broker relay, which Recall feeds the same `transcript.data`.

What is proven: the relay parsing and the two-source de-duplication (unit tests); the relay client
endpoint accepts a subscriber and reports it (`clients: 1` while a probe is connected); a transcript
injected into the relay's inbound side reaches the broker.

What is NOT proven: the bot page actually opening that second subscription. In a headless run the page
activates (`activations: 1`) but never appears as a relay client, so the address → answer hop is still
unverified outside a real call. Do not read the code being present as the path working.
