# Spend audit and remote-leave fix — 2026-09-09

Read-only Google Cloud Billing SKU inspection for the previously verified project and September 1–7 coverage found:

| SKU | Displayed usage (count) | Displayed net JPY |
| --- | ---: | ---: |
| Gemini 2.5 Flash Live Audio Input | 9,792,912 | 4,682 |
| Gemini 2.5 Flash Live Text Input | 3,785,848 | 302 |
| Gemini 2.5 Flash Live Audio (AV2A) Output | 104,439 | 200 |
| Gemini 2.5 Flash GA Thinking Text Output | 37,236 | 15 |
| Gemini 2.5 Flash Live Text Output | 30,122 | 10 |

Audio input represents about 89.8% of the ¥5,215 Vertex AI subtotal. These billing counts do not identify individual sessions, silent audio, repeated context, or the cause of excess input. No attribution to the latest Zoom test or proof of an idle connection leak is claimed. September 8–9 charges remain outside this report's displayed coverage.

Hosted Attendee bot enumeration completed both pages: 25 ended, 2 fatal_error, zero active. The local process check found no running script under scripts/reality; a Vite server was present. This does not establish that all possible direct cloud Live connections are absent.

## Confirmed code defect and correction

AttendeeSession.leave previously closed its browser socket only. The broker's client-close handler simply removed the relay client and did not issue a vendor bot leave request. Therefore the public operator Leave action did not itself stop the remote paid bot. Earlier automated tests used explicit vendor leave requests and their terminal states remain valid.

The creator session now sends POST to the existing broker bot-leave endpoint and checks its result before signaling left. Attach-only avatar sessions do not own or stop the remote bot. Concurrent leave requests are deduplicated; failed requests remain retryable. The controller no longer swallows the leave failure, and the meeting screen shows the error and leaves the retry control available. The receipt remains explicitly a local timing estimate, not a vendor exit or debit confirmation.

This defect could leave a bot running, but historical attribution of the recorded costs to this defect is unproven. No arbitrary session-duration limit or global billing cap was introduced. Paid AI evaluations were not run during this audit; the cloud deployment only publishes frontend assets.

Validation: 10 connector/receipt tests plus 5 controller reconnection/avatar regression tests passed. Workspace typecheck and production build passed. Tests verify creator-only remote leave, failure retry, deduplication and no remote leave from attach-only sessions. A new paid real-meeting test was deliberately not performed.

Deployed source `0980133` to Hosting `8c6668659d6f0fee` at 2026-09-09T14:39:34.652Z. The public bundle containing the leave fix was fetched and checksum-matched to the build. Backend unchanged.
