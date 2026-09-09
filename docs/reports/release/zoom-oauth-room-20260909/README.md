# Actual Zoom room verification — 2026-09-09

**Real admission and synthetic cue execution completed; Release remains BLOCKED.**

Yui was created through the public application's ordinary Zoom OAuth and Join flow, using backend revision `ai-meeting-broker-00015-6k4`. The tester was created through the Hosted Attendee API using the sole connected, authorized test account. This exercises public-UI Yui admission, not a public-UI tester feature.

Both bots entered the user-supplied Zoom room and obtained recording permission. The tester sent five audio cues (greeting, times/numbers, follow-up, a longer explanation, and conversation resumption). Its 159.74-second completed mixed-room recording contains audio after all five cues. Vendor captions attribute five utterances to Yui. These observations support speech reaching the room, but mixed audio is not isolated speaker scoring and does not establish latency or semantic accuracy.

Caption quality was poor: Japanese was transcribed incorrectly. Yui's own transcription state was `failed`; the tester's was `complete`. Neither is accepted as a semantic correctness gate. No barge-in timing, long-duration stability, human rating, or avatar visual score is claimed. The user's audiovisual confirmation is pending. Raw recording, captions, meeting credentials and signed URLs remain outside Git; the recording checksum is in result.json.

Both Yui (`bot_dENLz4LHHc8Ba9ix`) and Tester (`bot_pmQoGl8hPTfaAQzW`) were explicitly left and reached `ended`. The operator UI connection was also stopped. Cleanup completed at 2026-09-09T13:42:44.623Z.

## Defect found and fixed

The first public-UI Join attempt failed because a cached frontend referenced an old dynamic-import chunk that no longer existed. The missing JS URL returned the SPA HTML. A cache-bypassed page load restored the Join flow and no bot was created by the failed attempt.

The public HTML previously had `Cache-Control: max-age=3600`. Firebase configuration now requires revalidation (`no-cache, max-age=0, must-revalidate`). Hosting version `e860f83ef3a4e218` deployed this header at 2026-09-09T13:42:50.570Z, with zero application asset changes. The live HTML header was verified afterward. Already open/cached pages may still need a reload; this does not promise recovery for every old active tab.

Remaining release work: qualifying current-build latency/audio-quality measurements, required Meet/Zoom repetition and durations, physical-device recovery checks, 15 actual participants × 3 sessions, Zoom production review/external-account availability.
