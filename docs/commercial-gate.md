# Commercial gates — Google Meet resident AI

Two Recall bots talking to each other proves the transport. It does not prove a product a customer's
meeting can rely on. Nothing here is "done" because the code exists.

The gates are split, because they gate different promises:

- **Commercial Core** — "invite the bot to your Meet; the host admits it." Shippable with a documented
  limitation for Workspaces that refuse anonymous participants.
- **Authenticated Enterprise** — "it joins any company's Meet automatically." Only this one makes an
  authenticated bot a release blocker.

## Commercial Core

| # | Item | State | Evidence / what is missing |
|---|---|---|---|
| 1 | Conversational audio on Output Media | **PASS** | The character has always spoken through Output Media. Output Audio is now refused unless `RECALL_ALLOW_OUTPUT_AUDIO=1`, so the announcement endpoint cannot become the conversational path by accident. |
| 2 | Bot reserved ≥10 min ahead via Calendar V2 | **PASS** | Reserved when the event first syncs, armed ~12 min before; `decideEvent` refuses anything starting within 10 minutes (`starts_too_soon`). |
| 3 | Webhook-authoritative bot state | **PASS (code)** | See COMMERCIAL-GATE-04 below. |
| 4 | Fatal sub-codes as operator-readable errors | **PASS** | `describeBotFailure` covers `google_meet_bot_blocked`, `knocking_disabled`, `organisation_restricted`, `login_not_available` and the rest, and never blanks out on a code Recall adds later. |
| 5 | Participants told an AI is listening | **PASS (code), UNVERIFIED LIVE** | `chat.on_bot_join` notice; shape from Recall's reference, never exercised — the workspace ran out of credit first. Confirmed by a human in the smoke gate. |
| 6 | 402 / 507 are operational states, not outages | **PASS** | `BLOCKED_BY_RECALL_CREDIT` and `BLOCKED_BY_RECALL_CAPACITY`. |
| 7 | Usage visible | **PARTIAL** | `GET /api/recall/usage` reports billed bot hours. The public API does not expose remaining credit; the signals that exist are the 402 and dashboard auto top-up. |
| 8 | **10-minute smoke with real people** | **BLOCKER** | `pnpm reality:meet:human`. Never run — needs Recall credit. |
| 9 | **30-minute reality gate with real people** | **BLOCKER** | `MINUTES=30 pnpm reality:meet:human`, after #8 passes. |
| 10 | Two-bot run is a transport test only | **PASS** | `reality:meet:live` is labelled as such and does not stand in for #8 or #9. |

## COMMERCIAL-GATE-04 — webhook-authoritative state

The rule is not "delete the polling API". It is: **webhooks are the only thing that moves product state,
and the direct GET survives as an admin tool** — otherwise one dropped delivery leaves a meeting stuck on
"joining" forever with no way back.

| Requirement | State | How |
|---|---|---|
| No status polling from the product UI | **PASS** | The bot page and operator UI never call it; state arrives on the relay. |
| No periodic polling in the backend happy path | **PASS** | `RecallConnector` defaults to `pollIntervalMs: 0`; the timer only starts if a deployment opts in. |
| Transitions driven by `bot.*` webhooks | **PASS** | The broker maps the events, updates the record, and pushes `bot.status_change` down the relay so clients learn without asking. |
| Duplicate delivery does not corrupt state | **PASS** | Queue de-duplicates on `webhook-id`; `shouldApplyStatus` refuses a repeat. |
| Out-of-order delivery does not go backwards | **PASS** | Status ranks are monotonic; `fatal` is the one state that always lands. Observed live: `in_call_recording` was processed before `in_call_not_recording`. |
| Bad signature → 401/403 | **PASS** | Verified against the raw body before parsing. |
| Unknown event / sub-code does not crash | **PASS** | Recorded with the reason and skipped; `describeBotFailure` still produces a message. |
| Handler re-runnable | **PASS** | Queue retries with backoff; applying is idempotent. |
| Event id stored with the update | **PASS** | Lifecycle entries carry the event, and skipped ones carry why (`event:out_of_order`). |
| Fast ACK | **PASS** | Verify → enqueue → 2xx; all work happens in the queue worker. |
| Manual reconcile, admin only | **PASS** | `POST /api/meeting/recall/bots/:id/reconcile` behind `RECALL_ADMIN_TOKEN`, monotonic like the webhook path. |
| Reconcile not reachable from normal use | **PASS** | Not called by any product code path. |
| Traceable without secrets | **PASS** | One line per delivery: bot id, meeting id, event id, event, status, sub-code, received-at, transition latency, applied, reason. |

Still to prove in a live call: that a missed delivery, reconciled, actually recovers the meeting. That is
part of the operations gate below.

## Authenticated Enterprise (separate release)

| # | Item | State |
|---|---|---|
| 1 | Authenticated Google Meet bot | **CODE DONE, BLOCKED_BY_GOOGLE_WORKSPACE** — `RECALL_GOOGLE_LOGIN_GROUP_ID` is sent on ad-hoc and scheduled bots. Needs a **separate paid Google Workspace with org-wide SSO**; Recall is explicit that an existing one must not be reused, because the SSO policy is organisation-wide. |
| 2 | Verified against a Workspace that refuses anonymous joins | Not started |
| 3 | Bot account on the calendar invite, waiting room skipped | Not started |

Until this passes, the honest product claim is "the host admits the bot", and Workspaces that block
anonymous participants are **not supported** — stated, not discovered by the customer.

## Operations gate

| Item | State |
|---|---|
| Missed webhook → reconcile → correct state, in a live call | Not started |
| Auto top-up configured | Operator action (dashboard setting; not an API) |
| Usage alerting | `GET /api/recall/usage` exists; no alerting yet |

## Cost, because it is a production requirement

Pay-as-you-go is $0.50/bot-hour, and `web_gpu` — which Live2D needs, since no other variant has WebGL —
is $1.50/hour. **Waiting-room time is billed.** Two bots doubles it, which is one more reason the two-bot
run is a transport test and not the gate. This session spent the $5 free grant: 0.92 h at 2-core and
2.97 h on GPU, mostly on debugging.
