# Zoom OAuth deployment and verification — 2026-09-09

Release remains **BLOCKED**, not GO. This update closes the missing per-user Zoom authorization implementation and verifies its live account lifecycle. It does not complete meeting audio or human-study gates.

## Deployed candidate

- Backend source `45755f5`, Cloud Build `650c63b1-5700-4420-8edc-a7e9c19d067c` SUCCESS; Cloud Run `ai-meeting-broker-00015-6k4`, 100% traffic.
- Frontend source `872a13c`, Hosting `f6b5c3bd7d3ad65a`, released 2026-09-09T13:28:17.628Z at https://ai-meeting.web.app/.
- Named Firestore database `ai-meeting-zoom`, native/asia-northeast1, service-account access and expiresAt TTL enabled.
- Fixed callback and strict Zoom redirect matching configured. Zoom remains a development app; public review has not been completed.

## Verified

- Full local suite: **746 tests / 74 files passed**; workspace typecheck and production frontend build passed; diff whitespace check passed.
- Public browser, final deployment: Zoom connect → connected; one-click disconnect → disconnected without error; reconnect → connected. No meeting bots were started in these account tests. Browser left connected, meeting status unjoined.
- Connection state survived earlier backend revision 00013 → 00014. Server-side storage, not an in-process map, supplies connection state.
- A real Attendee successful DELETE returned an empty body; the original implementation incorrectly showed a failure after deletion. A regression test reproduced this; successful empty DELETE handling was fixed and verified live.
- Superseded application sessions cannot use or disconnect a newly authorized grant. Regression test failed before the fix and passed afterward. Provider identity is derived server-side and request-body identities are ignored.
- Three real cloud Gemini lifecycle runs all passed 12 checks each: initial connection, resumption after transport termination, no events after leaving, fresh conversation isolation, cancellation during connection, and overlapping connection handling. See lifecycle-1.json through lifecycle-3.json. These test sockets and lifecycle only, not audible quality, acoustic latency, long-duration stability or meeting admission.

## Remaining release evidence / external inputs

1. Latest voice onset fix still needs successful real-meeting retest. The previous room attempt ended with zoom_meeting_status_failed before any cues. A currently started Zoom meeting with the authorizing user present is needed; old room credentials were not retried blindly.
2. Required Meet/Zoom duration and repetition counts, physical-device checks, current-build audio quality and latency remain incomplete. Earlier voice failures remain documented and are not erased by OAuth or socket successes.
3. Actual 15 participants × 3 sessions and their ratings remain missing. Automated personas are not human participants.
4. General Zoom availability requires genuine operator/support/policy information, completed production configuration/review, and external-account trials. These details have been requested; no identity or policy URL was invented.

The release checker reports **1 passed, 49 blocked** using an empty current-build measurement set. These are missing qualifying measurements, not 49 new defects; the standalone lifecycle reports do not satisfy unrelated release metrics. Historical measurements were not relabeled for this candidate.
