# Hosted Zoom retest — 2026-09-09

**Release remains BLOCKED. The run completed, but functional verification did not pass.**

After the user admitted Yui and Tester to the newly supplied room, source `b944d8f` (Firebase Hosting `e31a3792a3225e0a`, broker `ai-meeting-broker-00012-xc9`) ran for 600,058 ms with 24 synthetic cue scenarios. Both bots were verified `ended` after the test. The final 35,924 ms silent observation contained zero new reply turns.

Findings:

- Two `unsanctioned` suppression events occurred during cue 2 (time confirmation). There were no further suppression events in the captured cue windows.
- The real-time mixed-audio observer detected energy above its threshold after 22 of 24 cues. Cues 3 and 4 had zero detected chunks; cue 4 measures the reply after the deliberate interruption, not the initial long answer.
- A separately downloaded 599.223-second mixed recording also had near-silent approximate response windows for cues 3, 4 and 6 (RMS about 0.000002). Cue 6 had six threshold-crossing real-time chunks despite the quiet recording window. Energy counts are diagnostic, not success counts.
- Cue 22 contained an interruption event without an intentional Tester interruption. Whether other meeting audio caused it is unknown.
- The page animation-frame heartbeat ranged from 2 to 18 fps. Maximum wall-clock minus audio-context advancement over a heartbeat interval was 2,593 ms. This is an audio-clock diagnostic, **not** measured end-to-end response latency. Browser resource contention is a hypothesis, not a confirmed root cause.
- The previous run's failing cue positions 18 and 19 produced response events and mixed audio this time. This does not prove the transcript fix resolves all failures.

`result.json` contains sanitized event and playback evidence; `recording-check.json` contains RMS values for approximate windows from 0.5 to 14.5 seconds after scheduled cue completion. Mixed audio does not prove speaker identity, intelligibility or semantic correctness. No new human confirmation of avatar/audio was received during this run. This is one synthetic 10-minute run and does not satisfy the required long sessions or 15-person × 3-session human study.

Next investigations: correlate input transcription and address-policy decisions for cue 2; reproduce page/audio-clock slowdown with lower rendering load and compare an independently recorded output; identify the unplanned interruption. The test does not establish general-user Zoom OAuth availability or production approval. Meeting URLs, passwords, client tokens, signed recording URLs, recordings and raw transcripts are excluded from Git.
