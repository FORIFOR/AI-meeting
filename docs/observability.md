# Observability & presence incidents (Round 3 · Gate 6 / Gate 7)

## Session report (`@rcai/observability` · `SessionObserver.toReport()`)
Numbers only — the observer never stores transcript text, so a report is telemetry-safe by construction.

| Field | Source | Meaning |
|---|---|---|
| `provider`, `engines` | `session_ready`, `metrics.engines` | conversation provider; local agent VAD/STT/LLM/TTS engine names |
| `turns.user / assistant / interruptedAssistant` | final `user_transcript`, `assistant_speech_ended`, `interrupted` | turn counts |
| `responseLatency` (p50/p95/max + histogram 0-300/300-500/500-700/700-1000/1000-1500/1500-2000/2000-3000/3000+) | `user_speech_ended → assistant_speech_started` | spec §27 KPI |
| `interruptStop`, `listeningReact` | runtime `LatencyTracker` samples | barge-in audio stop, speech → LISTENING |
| `reconnects` | `session_ready` after the first (providers emit it after a successful reconnect) | |
| `interruptions.byUser` | `user_speech_started` while the assistant speaks | |
| `staleDrops` | `ConversationRuntime.stats.staleDrops` (Gate 1 generation ids) | late chunks dropped |
| `stt`, `llmTtft`, `ttsTtfa`, `firstAudio` | `metrics` events (`TurnMetrics`) | local pipeline breakdown |
| `avatar.frameIntervalMs` | rAF probe in `IncidentRecorder.startProbe` | render cadence |
| `avatar.lipDelayMs` | speaker-tap loud frame → first `getParams().mouthOpenY > 0.1` | audio → lip |
| `meeting` | `setMeetingState(connector, state, botId)` | meeting connector state |
| `errors.count/fatal/codes` | `error` events (+ `noteError`) | only code-like tokens (`BLOCKED_BY_*`) are kept, never messages |

Live: the latency HUD shows turns / reconnects / stale drops / STT·TTFT·TTFA p50 / lip delay. End: Result screen "セッションレポート" card + `レポートをコピー` (markdown).

## Telemetry
`createTelemetrySender({ brokerUrl, privacyMode }).send(report)` → `POST /api/telemetry` with `{ schema: "rcai.telemetry.v1", report: sanitizeForTelemetry(report) }`.
- `sanitizeForTelemetry` = `stripContent` (drops any key matching text/transcript/caption/prompt/content/quote/note/utterance/audio/video/image and any string > 64 chars) + `privacyGuard.sanitizeTelemetry`.
- **strict_local ⇒ no request at all** (`"skipped-strict"`), tested.
- Broker rejects any envelope containing a content-like key anywhere (400 with the offending path) and anything > 256 KB; writes `docs/reports/telemetry/<date>.jsonl` (git-ignored).

## Presence incidents (「不自然だった瞬間」)
`IncidentRecorder` keeps a 20 s ring of: ConversationEvents (text ≤ 200 chars), avatar state transitions, motion clip per layer (10 Hz), `setEmotion` / `performGesture` / `setGaze` calls (avatar proxy), VAD level (10 Hz), latency samples, provider changes, errors, generation ids / stale drops when present.
`capture()` → `PresenceIncident { id, sessionId, at, windowMs: 10000, reason, note?, provider, avatarState, entries[rel −5000…+5000 ms], hud, userOptIn, mode, characterId }`; the +5 s half is merged 5.2 s later, then the incident is saved (localStorage metadata, no media) and POSTed to `/api/incidents` → `docs/reports/human/incidents/<sessionId>/<id>.json`.

### Privacy rules
- Audio/video are **OFF by default**. The panel checkbox 「音声/映像を保存する」 must be ticked in each session; only then a 5 s mic ring + 5 s assistant ring (16 kHz PCM16 → WAV) and one self-camera JPEG (if the camera is on) are attached.
- The broker writes media **only if the incident itself carries `userOptIn.audio/video = true`** (defence in depth) and caps media at 5 MB.
- `strict_local`: incidents never leave the browser (copy `incidents JSON` on the Result screen).
- localStorage never holds media; `saveIncidentMeta` strips it.
