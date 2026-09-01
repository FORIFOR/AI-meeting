# Commercial reality gate — Google Meet resident AI

Two Recall bots talking to each other proves the transport. It does not prove a product that a customer's
meeting can rely on. This is the list that does, and nothing here is "done" because the code exists.

## Status

| # | Item | State | Evidence / what is missing |
|---|---|---|---|
| 1 | Conversational audio on Output Media, not Output Audio | **DONE** | The character has always spoken through Output Media (`RecallConnector.endOutboundUtterance` returns early in that mode). The Output Audio endpoint is now off unless `RECALL_ALLOW_OUTPUT_AUDIO=1`, so it cannot become the conversational path by accident. |
| 2 | Calendar V2 → bot reserved ≥10 min ahead via `join_at` | **DONE** | Reserved when the event first syncs (hours/days ahead), armed ~12 min before; `decideEvent` refuses anything starting within 10 minutes (`starts_too_soon`). |
| 3 | Authenticated (signed-in) Meet bot as the commercial join path | **CODE DONE, BLOCKED_BY_GOOGLE_WORKSPACE** | `RECALL_GOOGLE_LOGIN_GROUP_ID` is sent as `google_meet.google_login_group_id` on both ad-hoc and scheduled bots. It needs a **separate paid Google Workspace with org-wide SSO** — Recall is explicit that an existing Workspace must not be used, because the SSO policy is organisation-wide. That provisioning is the operator's. |
| 4 | Webhook-driven bot state, no polling in production | **PARTIAL** | The broker consumes and verifies `bot.*` webhooks and keeps the lifecycle on the meeting record. `GET /api/meeting/recall/bots/:id` still polls Recall and is still used by the harnesses — it has to go from the product path. |
| 5 | Fatal sub-codes surfaced as operator-readable errors | **DONE** | `describeBotFailure` in `@rcai/meeting-core` maps `google_meet_bot_blocked` / `knocking_disabled` / `organisation_restricted` / `login_not_available` and the rest to a message plus the action that fixes it, and never blanks out on a sub-code Recall adds later. |
| 6 | Participants told an AI is listening | **DONE, UNVERIFIED AGAINST THE LIVE API** | The bot posts a notice to the meeting chat on join (`chat.on_bot_join`, `RECALL_JOIN_NOTICE` to change or disable). The payload shape is from Recall's Create Bot reference and has not been exercised — the workspace ran out of credit before it could be. |
| 7 | Balance / usage monitoring and auto top-up | **PARTIAL** | `GET /api/recall/usage` reports billed bot hours (cached, the endpoint is rate limited to 5/min). The public API does **not** expose remaining credit, so the operational signal is `BLOCKED_BY_RECALL_CREDIT` (mapped from Recall's 402) plus auto top-up, which is a dashboard setting. |
| 8 | 30-minute Meet with at least one real person | **BLOCKER** | Never run. Needs: addressing, barge-in, several speakers, silence, and the bot rejoining. |
| 9 | Two-bot run kept as a transport test only | **DONE** | `pnpm reality:meet:live` is labelled as such here and does not stand in for #8. |
| 10 | No "commercially ready" until every row passes | — | Rows 3, 4 and 8 are open. |

## What #8 has to measure

A person in the meeting, the character in the meeting, thirty minutes:

- addressed by name mid-conversation, several times, with other talk in between
- interrupted mid-answer (barge-in), and audio stops
- two or more human speakers, so diarisation and "who addressed me" are real
- long silences, without the character filling them
- the bot removed and re-sent, rejoining cleanly
- the transcript and notes that come out afterwards

## Cost, because it is a production requirement

Pay-as-you-go is $0.50/bot-hour, and `web_gpu` — which Live2D needs, since no other variant has WebGL —
is $1.50/hour. **Waiting-room time is billed.** A two-bot test doubles it. This session spent the $5 free
grant: 0.92 h at 2-core and 2.97 h on GPU, mostly debugging.
