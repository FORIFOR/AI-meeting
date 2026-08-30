# P0-4 — Acoustic Reality Gate with real audio devices (2026-08-30)

**Hardware reality**: this machine is a Mac mini with **no physical microphone**; input devices = `BlackHole 2ch` (virtual loopback) only, output = built-in speakers. Therefore:
- AirPods / built-in mic / USB mic / Bluetooth: **BLOCKED_BY_NO_MIC_DEVICE** (must be run on a laptop; the runner below works unchanged with a real mic — omit the BlackHole switching).
- What *was* tested with real (non-fake) device capture: the loopback configuration where **everything the browser plays is fed straight back into its microphone at full level** — the hardest possible echo path for the AEC and the classic "AI hears itself" failure.

Runner: `apps/web/scripts/acoustic-gate.mjs <utter1.wav> <utter2.wav>` — switches system output+input to BlackHole (`SwitchAudioSource`, restored on exit), launches real Chrome (headless, **no fake-device flags**, `--use-fake-ui-for-media-stream` only grants permission), seeds settings `inputDeviceId/outputDeviceId` = BlackHole (new `Settings` fields wired to `MicCapture`/`AudioContext.setSinkId`), strict_local + Local engine, Free Talk / yui. "User" speech is injected by `afplay` into the same loopback.

## Result (docs/reports/img/p0-4-acoustic-results.json, p0-4-acoustic.png)
| Check | Result |
|---|---|
| AI opening + answers played into its own mic (phase 1, 14 s, nothing else playing) | **0 self-triggers** — Speaking never flipped to Listening on its own voice (Chrome AEC3 + Silero VAD + runtime local VAD) |
| User utterance through loopback | Listening in **0 ms** (HUD), STT 「こんにちは。今日は面接の練習をお願いします。」 correct, AI answered (turn 1564 ms p50 with avspeech daemon) |
| Barge-in: utter2 played while the AI was speaking | Speaking → Listening **272 ms** after `afplay` started (includes the WAV's leading silence + Silero end-pointing); HUD barge-in audio stop **43 ms**; second answer正しく生成 |
| Egress under strict_local | `{"entries":[]}` |
| Errors | one non-fatal `AbortError: Unable to load a worklet's module` at t≈5.5 s during the throwaway permission page navigation (session unaffected) — tracked as a follow-up |
| Observed jitter | after the interruption the pill flickered Speaking→Listening→Speaking→Listening within ~200 ms (a late audio chunk before the agent's `interrupted`); cosmetic, tracked |

State timeline: Connecting → Speaking(opening) → Idle → Listening → Thinking → Speaking → Idle → Listening → Thinking → Speaking → **Listening (barge-in)** → Thinking → Speaking.

## Verdict
- Self-echo suppression with real device capture: **PASS** (loopback, worst case).
- Barge-in on real device path: **PASS** (< 300 ms end-to-end, 43 ms audio stop).
- Physical mic / AirPods / noise suppression / AGC on a laptop: **BLOCKED_BY_NO_MIC_DEVICE** — run `node apps/web/scripts/acoustic-gate.mjs` on a MacBook (it auto-detects; without BlackHole it should be run with `--devices default` — TODO flag) or follow `docs/human-gate.md` with a tester.
