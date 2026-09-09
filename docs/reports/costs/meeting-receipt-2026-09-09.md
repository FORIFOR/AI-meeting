# Per-meeting credit receipt

Operator screens now show a receipt above the account-wide cost panel after an Attendee meeting terminal notification or the local Leave action. It contains observed duration, one-bot credit estimate, USD equivalent at the standard $0.50/credit rate, and a link to the vendor transaction history.

This is **estimated consumption**, not a confirmed debit or remote-exit confirmation. Timing begins when the controller reports bot creation and ends at the first terminal event or the local Leave action. It includes observed waiting/reconnection time but cannot capture all vendor startup/post-processing time or survive a page reload. Unknown/zero-duration observations are shown as unavailable, not free. Failed creation without a bot-created observation produces no receipt. Recall and bot-renderer pages do not use Attendee rates.

Terminal notifications are idempotent, and a new attempt starts with a fresh receipt tracker. Late status callbacks from old attempts cannot replace the current attempt's receipt. A provider ledger API for exact per-bot deductions was not available in the prior investigation, so no exact amount is fabricated and the shared account snapshot is not decremented from estimates.

Validation: nine targeted tests passed (tracker edge cases, terminal notifications, screen receipt visibility, duplicate events, next-meeting reset, local Leave, settings regression). Web typecheck and production build passed. No real paid meeting was started solely to test this display; this report does not claim a new live admission or billing reconciliation.

Deployed source `d881122` to Hosting `beb87829bdd7798b` at 2026-09-09T14:25:18.557Z. The public JavaScript bundle containing the receipt was fetched and checksum-matched to the local build. Existing cache revalidation settings were preserved. Backend unchanged.
