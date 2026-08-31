# Recall Calendar V2 — application side

Workspace **NEXT-STANDARDS** (`13636071-5bda-4018-adaf-55c71fa4003a`), region **ap-northeast-1**, API **v1.11**.
Provider: **Google Calendar**. Sources of truth: `recall://guides/calendar-v2-setup`,
`recall://guides/calendar-v2-setup-google`, plus the docs `calendar-v2-webhooks`,
`calendar-v2-integration-guide`, `scheduling-guide`, `calendar_events_list`, `calendar_events_bot_create`.

No Calendar V2 MCP **write** tool was called from this work — setup writes stay with the parent.

## The opt-in rule, as implemented

Connecting a calendar authorises event sync only. A bot is scheduled **exclusively** when the event
title carries a marker. `packages/meeting-core/src/scheduling.ts` (`decideEvent`) returns
`{ eligible, reason }` in this order — the first hit wins:

| # | Condition | Result |
|---|---|---|
| 1 | `is_deleted` | skip `deleted` |
| 2 | provider status `cancelled` | skip `cancelled` |
| 3 | unparseable `start_time` | skip `invalid_start_time` |
| 4 | start ≤ now | skip `already_started` |
| 5 | start − now < `leadMinutes` (default **10**) | skip `starts_too_soon` |
| 6 | no `meeting_url` | skip `no_meeting_url` |
| 7 | link is not Meet/Zoom/Teams/Webex | skip `unsupported_platform` |
| 8 | manual override = opt-out | skip `opted_out` |
| 9 | manual override = opt-in | **eligible** `manual_opt_in` |
| 10 | title contains a marker (default `#yui`, `#rehearsal`) | **eligible** `marker_matched` |
| 11 | otherwise | skip `no_marker` |

Matching is NFKC-folded and case-insensitive, so `＃ＹＵＩ` typed on a Japanese IME matches `#yui`.
A manual opt-in can never resurrect a deleted, cancelled or past event. Markers and lead time are
editable at `PUT /api/calendar/rule`; overrides are per event and durable.

## Scheduling behaviour

- `calendar.sync_events` → List Calendar Events with `updated_at__gte = last_updated_ts` → decide →
  `POST /api/v2/calendar-events/{id}/bot/` or `DELETE …/bot/`.
- `deduplication_key = "{start_time}-{meeting_url}"` (Recall's recommended “deduplicate all”), so one
  bot serves a meeting shared by several connected calendars.
- Re-sync of an unchanged event is a no-op; a moved event is **re-scheduled** through the same
  endpoint (Recall overrides the previous bot) rather than deleted and recreated.
- A deleted event only clears our ledger — Recall unschedules those bots itself.
- `calendar.update` with `status: disconnected` clears the ledger for that calendar.
- The scheduling intent is written to `MeetingStore` **before** the schedule call, so an ambiguous
  failure is reconciled instead of blindly retried.

**Two-phase bot config.** `bot_page` session tokens live 15 minutes, but an event may be days away,
so scheduling happens in two steps: at sync time the bot is reserved with `{bot_name}` only; at
`armDueEvents()` (default 12 min before the start, matching the guide's ≥10 min advice) the full
config is pushed — realtime relay websocket, `output_media` webpage with fresh tokens, metadata.
Arming is idempotent per event (`armedAt`) and reports `BLOCKED_BY_RECALL_PUBLIC_URL` when the
tunnels are not configured rather than half-arming a bot.

## Files

| File | What it does |
|---|---|
| `packages/meeting-core/src/scheduling.ts` | pure opt-in rule, `deduplicationKey`, JA reason strings |
| `packages/meeting-core/src/scheduling.test.ts` | 27 rule tests |
| `packages/meeting-core/src/index.ts` | re-export (1 line) |
| `services/token-broker/src/recall/calendarClient.ts` | `/api/v2` client: calendars, events (cursor), schedule/unschedule bot; retries 409/429/503/507 |
| `services/token-broker/src/recall/calendarStore.ts` | durable rule + overrides + scheduling ledger + sync cursors |
| `services/token-broker/src/recall/calendarSync.ts` | reconcile, `syncCalendar`, `armDueEvents`, `upcoming`, `handleCalendarWebhook`, `isCalendarEvent` |
| `services/token-broker/src/recall/calendarBotConfig.ts` | reserve/arm `bot_config` factory (relay + Output Media) |
| `services/token-broker/src/routes/calendar.ts` | OAuth callback forwarder + status/events/optin/optout/rule |
| `services/token-broker/src/recall/calendar.test.ts` | 29 sync, webhook, callback and client tests |
| `services/token-broker/src/app.ts` | route registration, calendar deps, `calendar.*` webhook dispatch |
| `services/token-broker/src/env.ts` | `RECALL_CALENDAR_REGIONAL_CALLBACK_URI`, `RECALL_BOT_NAME` |
| `services/token-broker/package.json` | `@rcai/meeting-core` workspace dep |

## HTTP surface

| Route | Purpose |
|---|---|
| `GET /api/meeting/calendar/oauth-callback` | customer-owned callback; forwards only `state`, `code`, `error`, `recall_calendar_setup_probe` to `RECALL_CALENDAR_REGIONAL_CALLBACK_URI` and returns the response verbatim. A probe without `code`/`error` is valid. Logs record only `{op, accepted, kind}` — never values, codes, state or the URL. |
| `GET /api/calendar/status` | calendars with `status`, `platformEmail`, `connected`, `readyForTesting` |
| `GET /api/calendar/events[?calendar_id=]` | upcoming events (28-day window) with `{eligible, reason, matchedMarker, override, botId}` |
| `POST /api/calendar/events/:id/optin` \| `/optout` | manual override, then reconcile that event |
| `GET`/`PUT /api/calendar/rule` | read/update markers + lead time |

## Commands and results

```
pnpm vitest run packages/meeting-core/src/scheduling.test.ts   → 27 passed
pnpm vitest run services/token-broker/src/recall/calendar.test.ts → 29 passed
pnpm -r typecheck                                              → all packages Done
pnpm vitest run                                                → 38 files / 387 tests passed
```

Live route smoke through `createApp` (no API key in the injected env):

```
status   503 {"error":"BLOCKED_BY_RECALL_KEY"}
events   503 {"error":"BLOCKED_BY_RECALL_KEY"}
rule     200 {"rule":{"markers":["#yui","#rehearsal"],"leadMinutes":10,"skipPast":true}}
callback 503 BLOCKED_BY_RECALL_CALENDAR_CALLBACK: set RECALL_CALENDAR_REGIONAL_CALLBACK_URI …
```

## Blocked — remaining user actions (parent runs the MCP setup flow)

1. **Public HTTPS origin** (ngrok reserved domain). `RECALL_PUBLIC_URL` / `RECALL_BOT_PAGE_URL` are
   still empty; the callback path `/api/meeting/calendar/oauth-callback` must be reachable on the
   broker's public origin, and the guide warns to keep
   `/api/internal/calendar-integration/setup/provider-callback/` routed to the local Meeting API when
   a single origin serves both.
2. **`start_calendar_integration_setup`** (`platform=google_calendar`, `production_redirect_uri` =
   the public callback URL above, a stable `provisioning_idempotency_key`) → returns
   `regional_callback_uri`, which must be written to `RECALL_CALENDAR_REGIONAL_CALLBACK_URI` before
   the probe can pass.
3. **Google Cloud Console work by the mailbox owner** — every value comes from the returned
   `create_google_oauth_client` action: select/create the project; enable the Calendar API; set the
   consent screen name to `Recall.ai Calendar Setup`; choose Internal vs External (External + Testing
   issues 7-day refresh tokens — publish for a durable integration); declare exactly
   `calendar.events.readonly` and `userinfo.email`; create a dedicated **Web application** client with
   the exact `oauth_client_name`; add `exact_redirect_uri` under Authorized redirect URIs; download the
   client JSON and pass it once as `google_oauth_client_json` to
   `continue_calendar_integration_setup`, then delete the local copy.
4. **`verify_callback_forwarding`** probe, then `authorize_first_calendar` by the mailbox owner.
5. Completion is only real when the calendar is `connected`, `platform_email` is populated, the first
   full sync finished and `ready_for_testing=true`.

Once connected: `GET /api/calendar/status` shows the calendar, `GET /api/calendar/events` shows the
28-day window with decisions, and a `#yui` in an event title schedules the bot. `armDueEvents()` is
exported and idempotent but is **not yet on a timer** — the parent (or Fork R1's worker) should call
it every few minutes; that is the one wiring step left inside the app.
