# Meeting completion credit receipt — 2026-09-10 JST

The completed meeting now presents a focused usage card before the join form. Its main content is the meeting Bot's estimated consumed credits and observed duration. Price calculations and any available AI usage are inside expandable details. Service-wide historical account usage is separately collapsed and explicitly labelled as service-wide; it is not the current user's wallet.

Credits remain a browser-duration estimate (one Bot, rounded up to 0.01 credit), not a vendor-confirmed deduction. The UI says this directly. Unknown credits and missing AI measurements are not shown as zero. No account balance subtraction or fabricated total AI credit conversion is used.

A failed leave request no longer freezes the receipt at the attempted exit time. Successful leave or a terminal meeting event finalizes the observation once. Repeated terminal events preserve that value, a new meeting clears it, and delayed AI usage updates do not steal keyboard focus again.

Validation:
- 11 focused tests passed, including host termination, duplicate terminal events, a failed leave followed by successful retry, new-meeting reset, unknown amounts and keyboard focus behavior.
- The actual component was opened locally with a synthetic 30-minute/0.50-credit example; the accessible view contained the result heading, credit amount, duration and collapsed detail section, with focus on the receipt. The temporary preview was removed before building.
- An initial full-gate invocation mistakenly propagated cloud-browser build flags into Node tests (9 import failures, `window is not defined`). The test and production-build configurations were separated for the final check; this is not counted as a passing attempt.
- Final `pnpm gate` passed: 778 tests in 85 files, workspace typechecks and web build. License checks passed and the notices were refreshed against the current lockfile dependencies.
- No paid AI sessions or meeting Bots were created for this UI change.

Release decision is governed by `docs/reports/release/meeting-receipt-gate-20260910.json`. Public release remains blocked by missing current-candidate measurements and human evaluation. The 30-minute cost experiment from the preceding change does not establish meeting quality; caption observation remains opt-in. Current real Meet/Zoom access and 15-person, three-session-per-person evaluation evidence were requested. No release thresholds or approval policy were weakened to make the gate pass.
