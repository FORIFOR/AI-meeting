# P0-2 — Real-credential 30-minute soak harness (OpenAI Realtime / Gemini Live / Local) + reconnection

Date: 2026-08-30 · Fork I

## Verdict
| Engine | Status | Evidence |
|---|---|---|
| local | **PASS** — 10-minute soak executed, session survived, 98 % answered, 0 errors | `docs/reports/soak/local-2026-08-30T00-41-00.{md,json}` |
| openai | **BLOCKED_BY_OPENAI_KEY** — harness verified to refuse (exit 2) without a key | `docs/reports/soak/openai-2026-08-30T00-33-51.md` |
| google | **BLOCKED_BY_GEMINI_KEY** — same | `docs/reports/soak/google-2026-08-30T00-33-51.md` |
Reconnect logic: implemented + unit-tested for both cloud providers (7 new tests); not exercised against the real APIs (no keys).

## Files
- `apps/web/scripts/soak-browser.mjs` (new) — headless-Chrome soak runner (`--engine openai|google|local --minutes N --wav <file|dir> --mode --character --base --broker --agent --out`). Preflights `/health`, seeds settings (strict_local for local), drives Home → (Setup) → Session, polls every 500 ms (pill, captions, HUD, toasts, console/page/http errors, reconnect console lines), ends the session, reads the Result screen, writes `docs/reports/soak/<engine>-<ts>.{json,md}`. Verdict PASS only if survived full duration ∧ answered ≥ 80 % ∧ no page error ∧ no fatal/BLOCKED toast; missing key ⇒ `BLOCKED_BY_*` and exit 2.
- `apps/web/scripts/lib/make-soak-wav.mjs` (new) — loop-safe fake-mic WAV generator (`say -v Kyoko`; 24 varied statements/questions, a barge-in utterance every 5th turn with a 2 s gap so it lands while the assistant speaks, 4–8 s seeded random gaps, 3 s lead silence) + `.timeline.json`; RIFF parser tolerant of `say`'s FLLR chunks.
- `providers/openai/src/provider.ts` — reconnection: `connectionstatechange` → `failed` ⇒ reconnect; `disconnected` ⇒ 3 s grace then reconnect if not recovered; up to `maxReconnects` (3) with backoff 1/2/4 s (`reconnectBackoffMs`), new ephemeral token + peer connection + data channel + `session.update` with the same instructions/voice; emits `interrupted` (if speaking) + `error{fatal:false}` first, `session_ready` on success, `error{fatal:true}` + `session_closed{reason:"reconnect exhausted"}` after exhausting. Stale data-channel `onclose` no longer emits `session_closed`. Persistent output: remote tracks are routed through one `MediaStreamAudioDestinationNode` (`getOutputStream()` stays the same object across reconnects — `ConversationRuntime.attachOutputStream` attaches only once) plus a hidden muted `<audio>` element (Chrome only feeds remote WebRTC audio into WebAudio when bound to a media element). Speech-ended safety timer: if no `output_audio_buffer.stopped/cleared` arrives within `speechEndedTimeoutMs` (30 s) after the last speech activity, a stop is synthesised through the mapper. `diagnostics` (reconnects / failures / connection states) for harnesses.
- `providers/gemini/src/geminiLiveProvider.ts` — abnormal socket close (code ≠ 1000) and `goAway` now retry up to `maxReconnects` (3) with backoff (goAway first attempt immediate), re-fetching an ephemeral token and re-sending `setup` with the last `sessionResumption` handle; `interrupted` if audio was in flight; `session_closed` only for clean 1000 closes or after exhaustion; stale sockets ignored; `diagnostics`.
- `providers/openai/src/openai.test.ts` (+4 tests), `providers/gemini/src/gemini.test.ts` (+3 tests).
- `services/token-broker/README.md` (new) — `.env` keys, `/health` semantics, how to run the per-engine soak and what it proves.
- `docs/reports/soak/*` — run artefacts.

## Commands & results
```
node apps/web/scripts/lib/make-soak-wav.mjs --minutes 10 --out $TMP/rcai-soak/soak-10m.wav   → 598.7 s, 71 utterances (14 barge-ins)
node apps/web/scripts/soak-browser.mjs --engine openai --minutes 1                             → # Soak openai — BLOCKED (BLOCKED_BY_OPENAI_KEY), exit 2
node apps/web/scripts/soak-browser.mjs --engine google --minutes 1                             → BLOCKED_BY_GEMINI_KEY
node apps/web/scripts/soak-browser.mjs --engine local --minutes 10 --wav … --mode free_talk    → run 1 FAIL (see below), run 2 PASS
pnpm vitest run providers/openai providers/gemini                                              → 22 passed (15 before + 7 new)
pnpm --filter @rcai/provider-openai --filter @rcai/provider-gemini typecheck                   → Done / Done
```
Stack for the soak: `scripts/local-stack.sh start` (gemma-4-E2B), `pnpm --filter @rcai/agent start` (Silero VAD + SenseVoice + `say`), broker (no keys), web. All processes I started were stopped afterwards.

### Local 10-minute soak (run 2, `vite preview` build on :5180, strict_local, yui, free talk)
| metric | value |
|---|---|
| session survived | **yes (10.0 min)** |
| user utterances (final captions) | 42 / 71 in WAV (14 are deliberate barge-ins cut mid-sentence; partial-only captions not counted) |
| assistant turns / answered ratio | 53 / **98 %** |
| turn latency p50 / p95 (HUD, n=57) | **3001 / 3372 ms** |
| barge-in → audio stop (n=41) | **43 ms** |
| speech detected → LISTENING (n=71) | **0 ms** |
| audio stop → mouth closed (n=41) | 0 ms |
| speaking episodes / longest gap without assistant speech | 58 / 12.6 s |
| reconnects / toasts / console errors / page errors / http≥400 | 0 / 0 / 0 / 0 / 0 |
| assistant reply length (chars) min/p50/avg/max | 10 / 24 / 26 / 49 (spec §22: 1–3 short sentences ✓) |
| result screen overall | 69 |
Latency note: turn p50 3.0 s here vs 1.67 s in `gate7-web-e2e.md` — the agent log shows `say` TTS 1.2–1.7 s per sentence and LLM first token ~0.7 s while llama-server was shared with Fork J's concurrent latency experiments; this is the P0-3 workstream, not a regression of the harness (barge-in/listening numbers unchanged).

### Run 1 (dev server :5173) — FAIL, root cause outside the app
Session ended at 4.4 min: `500 /src/integrations/registry.ts?t=…` from Vite (a sibling fork was editing `apps/web/src/integrations/registry.ts` at that moment) → HMR full reload → session screen gone. Up to that point: 24 answered turns, barge-in 43 ms ×4. Run 2 therefore used the production build served by `vite preview` (no HMR); recommended for all soaks. Also observed (apps/web, out of my scope): React "two children with the same key" warnings from the captions list.

## Reconnect unit tests (fakes, fake timers)
| test | result |
|---|---|
| OpenAI: `failed` → backoff → new token/pc/dc → `session.update` re-sent, events `[session_ready, assistant_speech_started, interrupted, error(non-fatal), session_ready]`, no `session_closed`, old pc closed | ✓ |
| OpenAI: token 503 ×3 → 5 errors (1 reconnecting + 3 attempts + 1 fatal) + `session_closed{reconnect exhausted}` | ✓ |
| OpenAI: `disconnected` recovers within grace → no reconnect | ✓ |
| OpenAI: no stop event within 1 s (test) → synthesised `assistant_speech_ended`, later real stop not duplicated | ✓ |
| Gemini: close 1006 → backoff → new socket with `sessionResumption.handle`, 2× `session_ready`, audio flows on new socket | ✓ |
| Gemini: close 1000 → `session_closed`, no reconnect | ✓ |
| Gemini: token 503 → fatal error + `session_closed{reconnect exhausted}` | ✓ |

## P0-2 checklist mapping
| item | local (measured) | openai | google |
|---|---|---|---|
| connection | ✓ (session_ready, 10 min) | BLOCKED_BY_OPENAI_KEY | BLOCKED_BY_GEMINI_KEY |
| audio input | ✓ fake mic → VAD/STT, 42 final transcripts | harness ready (WebRTC mic track) | harness ready (16 k PCM) |
| native audio output | ✓ 58 speaking episodes, lip HUD | harness ready | harness ready |
| transcript | ✓ captions user/assistant | harness ready | harness ready |
| barge-in | ✓ 43 ms ×41 | harness ready | harness ready |
| reconnect | n/a (loopback WS) | unit-tested; live: BLOCKED | unit-tested; live: BLOCKED |
| session longevity | ✓ 10 min (30 min: run `--minutes 30`) | BLOCKED | BLOCKED |
| Japanese conversation | ✓ replies 10–49 chars, natural casual JP | BLOCKED | BLOCKED |

## To unblock (human)
1. `cp services/token-broker/.env.example services/token-broker/.env`, add `OPENAI_API_KEY` and/or `GEMINI_API_KEY`; restart broker; `/health` must show the provider `true`.
2. `pnpm --filter @rcai/web build && pnpm --filter @rcai/web exec vite preview --port 5180` (or `pnpm dev`), then `node apps/web/scripts/soak-browser.mjs --engine openai --minutes 30` and `--engine google --minutes 30`.
3. Evidence produced: `docs/reports/soak/<engine>-<ts>.md/json` — survived, answered ratio, latency p50/p95, barge-in, reconnect events (console `reconnecting`/`session_ready`), toasts/errors, reply-length stats, result score. "Provider switching = PASS" only when both cloud soaks pass with the same character/persona as the local run.
