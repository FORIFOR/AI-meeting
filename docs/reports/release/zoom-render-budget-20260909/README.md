# Meeting render budget and Zoom comparison — 2026-09-09

Release remains **BLOCKED**.

Source `0796faf`, Hosting `e9ef3978fd2b9861`, caps Live2D meeting framing at 15 render fps and a 640-pixel longest framebuffer dimension, including resizing, while preserving CSS framing. Normal operator rendering remains full resolution. Address decisions now report classification and text length without adding transcript text to those diagnostics.

Validation: 733 tests / 72 files, workspace typecheck, web typecheck and production build passed. The hosted Zoom comparison completed 600,933 ms and 25 synthetic cues. Both bots ended; the final 20,047 ms silent observation had no new turns.

The real-time observer detected audio in 23/25 response windows. Independent mixed-recording checks found near silence in cues 1 and 22, matching all five `unsanctioned` suppression events. In both cases model response started before the final input transcript, and the eventual transcript was classified `not addressed`. The original transcript contents were not added to this report. This ordering alone does not prove why recognition lost the address.

Page animation-frame scheduling ranged 55–60 fps, compared with 2–18 in the previous run; this is **not** the capped avatar render rate. Maximum five-second audio-clock drift was 212 ms, compared with 2,593 ms before. This supports reduced browser load but separate hosted runs are not a controlled CPU experiment. These diagnostics are not end-to-end response latency or human audio-quality ratings.

A subsequent, separate change `8e04001` retains at most 300 ms of quiet input while the assistant is speaking, forwarding it only when the input gate opens. Previously that onset was discarded irreversibly, even if it contained the first mora of the addressed name. Its regression fails before the change and passes after it; all 734 tests / 72 files, typecheck and build pass. Hosting `4d7525ae1b8147be` published the change. The comparison above does **not** validate this subsequent change live.

Remaining public-release work includes live validation of the onset fix and any residual suppression; required long-duration, failure and physical-device trials and latency targets; per-user Zoom identity/OAuth/revocation with production review; and actual 15-person × 3-session evaluations. No human study was substituted with synthetic bots.

The onset-fix live retry created both bots but Zoom reported `could_not_join_meeting / zoom_meeting_status_failed`. Both reached terminal `fatal_error` before admission. Cleanup verified their terminal states; zero audio cues ran. See `onset-live-retry.json`. A usable meeting is required to continue live validation.
