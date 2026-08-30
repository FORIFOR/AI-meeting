# Round 3 — Gate 6 (Presence Incident instrumentation) · Gate 7 (Production observability)

Date: 2026-08-30 · Fork R

## Verdict
- **Gate 6 — PASS (executed)**: 「不自然だった瞬間」 button captures ±5 s of presence context as one incident; real session in headless Chrome produced `docs/reports/human/incidents/s_mtf5poam/inc_mtf5pza1_0.json` (128 entries) + `.mic.wav` / `.assistant.wav` because the tester opted in; without opt-in no media is attached (unit + broker tests).
- **Gate 7 — PASS (executed)**: per-session `SessionReport` (provider, turns, response-latency histogram + p50/p95, reconnects, interruptions, stale chunk drops, STT/LLM TTFT/TTS TTFA, avatar frame interval + lip delay, meeting connector state, errors) shown live in the HUD and on the Result screen; telemetry sent to `POST /api/telemetry` → `docs/reports/telemetry/2026-08-30.jsonl`; under `strict_local` nothing is sent (tested, no fetch call).

## Files
| Path | What |
|---|---|
| `packages/observability/src/{types,stats,observer,telemetry,index}.ts` (+ `observability.test.ts`, 4 tests) | new `@rcai/observability`: `SessionObserver` (event-stream aggregation, `toReport()`, `toMarkdown()`), `histogram/summarize/Samples`, `stripContent` + `sanitizeForTelemetry` (uses `privacyGuard.sanitizeTelemetry`), `createTelemetrySender` (strict_local ⇒ `"skipped-strict"`, zero network) |
| `apps/web/src/session/IncidentRecorder.ts` (+ `.test.ts`, 4 tests) | 20 s ring of events (text ≤ 200 chars) / avatar state / motion clips per layer (10 Hz) / emotion·gesture·gaze (avatar Proxy wrapper) / VAD level (10 Hz) / latency samples / provider / errors / generation ids; opt-in 5 s mic + assistant PCM rings (16 kHz) → WAV base64; self-camera JPEG; rAF lip-delay + frame-interval probe; `capture()`/`complete()`; localStorage metadata (media stripped); `submitIncident` (local-only under strict) |
| `apps/web/src/session/SessionController.ts` | hooks only: observer + recorder creation, avatar wrapped, state/event/mic/speaker feeds, `captureIncident / setIncidentOptIn / incidents / observabilityReport`, report + incidents + telemetry outcome in `end()`, recorder disposal in teardown |
| `apps/web/src/session/useSession.ts`, `screens/Session.tsx` | expose `captureIncident`, opt-in, `observability` polling (500 ms) |
| `apps/web/src/components/HumanGatePanel.tsx` | 「不自然だった瞬間 ±5 s を記録」 button, opt-in checkbox (既定 OFF, explicit wording), incident counter |
| `apps/web/src/components/LatencyHud.tsx` | rows: turns / reconnects / stale drops · STT/TTFT/TTFA p50 · lip delay / frame interval / errors / meeting |
| `apps/web/src/screens/Result.tsx` | `SessionReportCard`: stats, latency histogram, incidents timeline, 「レポートをコピー」「incidents JSON をコピー」 |
| `services/token-broker/src/routes/incidents.ts`, `routes/telemetry.ts`, `app.ts` (+2 tests) | `POST /api/incidents` (id/sessionId validated, media written only if the incident's own `userOptIn` says so, 5 MB cap) → `docs/reports/human/incidents/<sessionId>/<id>.json` (+ `.mic.wav/.assistant.wav/.jpg`); `POST /api/telemetry` (`rcai.telemetry.v1` envelope, any content-like key anywhere ⇒ 400 with path, 256 KB cap) → `docs/reports/telemetry/<date>.jsonl`; CORS +5178 |
| `docs/observability.md`, `docs/reports/human/incidents/README.md`, `docs/reports/telemetry/README.md`, `.gitignore` | fields + privacy rules; storage dirs git-ignored except READMEs |
| `apps/web/scripts/r3-incident-e2e.mjs` | the evidence runner below |

## Commands / results
- `pnpm vitest run packages/observability` → 4 passed · `pnpm vitest run apps/web` → 11 passed · `pnpm vitest run services/token-broker` → 26 passed
- `pnpm vitest run` (whole repo, with the other Round-3 forks' work present) → **32 files / 275 tests passed**
- `pnpm -r typecheck` → all Done except `packages/meeting-core` (`src/lifecycle.ts` event-type union, Fork H/Gate 5 in-progress — **out of this fork's scope**, untouched)
- Real session (`node apps/web/scripts/r3-incident-e2e.mjs`; llama-server shared, agent `PORT=8794`, broker `PORT=8797`, web `vite --port 5178`, fake mic WAV 「最近ちょっと疲れていて、プロジェクトがうまくいかなくて悩んでいます」, privacyMode default, opt-in ticked): pills Speaking(opening)→Idle→Listening→Thinking→Speaking→Idle; HUD `turn 1380 ms · → listening 0 ms · turns 1/2 · reconnects 0 · stale 0 · stt/ttft/ttfa 0/657/71 ms · lip delay 90 ms · frame 71 ms · errors 0`; toast 「記録しました（±5秒）: inc_mtf5pza1_0」; Result card `TELEMETRY SENT`, 1 incident listed (128 entries · audio ✓); page errors 0, console errors 0. Screenshots `docs/reports/img/r3-gate6-incident.png`, `r3-gate7-report.png`; raw log `r3-gate6-7-e2e.json`. Processes I started were stopped (llama-server left up — shared).

### Saved incident (redacted excerpt, `inc_mtf5pza1_0.json`, 17 KB)
```
keys: at avatarState characterId entries hud id media mode provider reason receivedAt sessionId userOptIn windowMs
media: [inc_mtf5pza1_0.mic.wav, inc_mtf5pza1_0.assistant.wav]  optIn: {audio:true, video:true (no camera → no jpg)}
entries: 128 (vad 93, event 10, motion 9, emotion 6, gaze 5, state 3, gesture 2), rel −4922 … +4955 ms, provider local, avatarState SPEAKING
{"kind":"state","from":"LISTENING","to":"THINKING","event":"userSpeechEnded","rel":-2474}
{"kind":"emotion","emotion":"thinking","intensity":0.35,"rel":-2474}
{"kind":"motion","layer":"idle","clip":"think_look_up","rel":-2423}
{"kind":"state","from":"THINKING","to":"SPEAKING","event":"assistantSpeechStarted","rel":-1585}
{"kind":"event","type":"assistant_speech_started","gen":{"sessionId":"local_…","turnId":1,"generationId":2,"sequence":1},"rel":-1585}
{"kind":"event","type":"assistant_transcript","text":"そうなんだ、…","final":false,"gen":{…,"sequence":2},"rel":-1582}
{"kind":"motion","layer":"speech","clip":"speak_explain","rel":-1525}
{"kind":"motion","layer":"speech","clip":"speak_question","rel":-1325}
{"kind":"gesture","gesture":"eyebrow_raise","intensity":0.4,"rel":315}
{"kind":"gesture","gesture":"head_tilt","intensity":0.35,"rel":315}
{"kind":"state","from":"SPEAKING","to":"IDLE","event":"assistantSpeechEnded","rel":3374}
{"kind":"event","type":"metrics","gen":{…,"sequence":132},"rel":3376}
```
(The incident also shows Fork N's generation ids riding along on every assistant event.)

### Telemetry line (numbers only, `docs/reports/telemetry/2026-08-30.jsonl`)
`{"schema":"rcai.telemetry.v1","privacyMode":"default","report":{"sessionId":"s_mtf5poam","provider":"local","turns":{"user":1,"assistant":2,…},"responseLatency":{"count":1,"p50":1380,…,"histogram":[…]},"llmTtft":{"p50":657},"ttsTtfa":{"p50":71},"avatar":{"frameIntervalMs":{"count":259,"p50":71.3},"lipDelayMs":{"count":2,"p50":90}},"meeting":null,"errors":{"count":0,"fatal":0,"codes":[]}}}` — no `text`/`transcript` keys anywhere (broker would reject them).

## Privacy guarantees (tested)
- Audio/video default OFF; attached only after the per-session checkbox; broker additionally refuses media unless `userOptIn` is true in the incident; localStorage never holds media.
- `strict_local`: `submitIncident` → `"local-only"` (0 fetch calls), `createTelemetrySender.send` → `"skipped-strict"` (0 fetch calls).
- Telemetry route rejects `text/transcript/caption(s)/prompt/content/quote/note/utterance/audio/video/image/*WavBase64` at any depth (400 + key path).

## Notes / follow-ups (outside this fork)
- `sttMs` p50 reported as 0 by the agent in this run (Fork J's streaming-STT path reports STT time differently); the observer records whatever `metrics` carries.
- `packages/meeting-core/src/lifecycle.ts` typecheck errors belong to Gate 5's fork.
- Lip-delay probe uses `getParams()` at rAF cadence (71 ms p50 under SwiftShader); on a GPU it will be finer.
