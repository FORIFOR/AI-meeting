# Actual Zoom smoke test — 2026-09-09

**Cloud admission and bidirectional audio worked. Functional result: FAIL; Release: NO_GO.**

The user authorized creating the Zoom app and storing its development Client ID and Client Secret in Hosted Attendee. `AI Meeting Yui` has Meeting SDK and programmatic join enabled. Both bots joined the supplied meeting and obtained recording permission. The app is still in development; this does not establish external-account or general-user access.

- Duration: 600,137 ms (one 10-minute run).
- Synthetic cues: 24, with non-silent room audio detected in 22 post-cue observation windows.
- Cue 18 (follow-up) and cue 19 (long reply followed by an intentional interruption) had no post-cue room audio and a policy `cut: unsanctioned` event. Later cues resumed responding. The second window is after the interruption; it must not be interpreted as no initial long answer.
- Last silent interval: 39,140 ms, zero new turns.
- Bot page rendering and AudioContext heartbeat were active. Human confirmation of the displayed Zoom avatar and perceived audio quality remains pending.
- Yui `bot_6nNRuTCyMZxnuEC9` and Tester `bot_I6EhZYvMx33m9Gsl`: leave requested and **ended verified**.

Audio RMS proves sound was present, not semantic correctness, speaker attribution, naturalness or exact latency. This run does not satisfy the required 30/60-minute Zoom trials, physical-device checks, or 15-person × 3-session human evaluation. No meeting URL/password, credentials, signed recording URLs, or raw conversation transcripts are included.

General-user OAuth remains unimplemented; see [connection requirements](../../../architecture/zoom-user-connection.md). Resolve the observed response-suppression failures and repeat the live test before treating the voice path as passed.
