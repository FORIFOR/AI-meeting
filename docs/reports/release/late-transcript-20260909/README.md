# Late Gemini transcription recovery — 2026-09-09

**Release remains NO_GO / BLOCKED.**

A deterministic regression exposed a separate mechanism capable of losing addresses: after the input gate closes, Gemini's remaining input-transcription fragments were emitted as a new final utterance. A split such as `ゆ` followed by `い、その予定は何時に終わりますか。` lost the full name used to decide whether Yui should reply.

The provider now retains the utterance ID and accumulated text, sends late text as a revision, and does not emit a second final question. A newly recognized explicit address is handled before reply audio without sending Gemini a duplicate prompt. Transcript state resets between input turns, completed replies and connections. Existing safeguards for unaddressed meeting speech remain enabled.

Validation:

- New provider regression failed on the original implementation and passed on the fix.
- Full suite: 731 tests / 72 files passed.
- Subsequently added controller regression passed with its 13-test suite, including the negative unaddressed-speech case.
- Workspace typecheck, follow-up web typecheck, and public build passed.
- Firebase Hosting version `e31a3792a3225e0a` published from source commit `b944d8f`.

The exact cause of the two previous Zoom suppression events is **not proven** by this regression. A live retry created Yui and Tester but did not reach admission in five minutes. The harness requested leave and verified both bots `ended`. No updated live audio measurements were obtained. Do not relabel the previous candidate's results as measurements of this one.

Remaining work: validate the fix in a hosted meeting; investigate any remaining suppression; implement per-user Zoom OAuth and revocation/isolation checks; complete production review and privacy/retention disclosures; run the required long-session, failure and physical-device trials; collect actual 15-person × 3-session evaluations. The new candidate's release evidence intentionally contains no invented measurements. `reality.json` records missing evidence, not 49 newly found product defects.

## New user-provided Zoom room retry

On 2026-09-09 at 11:14 UTC, the same deployed candidate was retried using the newly supplied Zoom room. Both bot creations succeeded, but both remained `joining` for the five-minute admission window. No audio cues were executed. Both leave requests succeeded and both final states were verified `ended` at 11:19 UTC. The reason for admission failure is not established; this does not constitute an audio regression result. See `zoom-new-room-retry.json`. The private meeting URL and credentials are excluded. Release remains BLOCKED.

The subsequent admitted run completed 24 cues in 10 minutes but retained suppression and playback anomalies. See [the admitted Zoom retest](../zoom-new-room-20260909/README.md). Release remains BLOCKED.
