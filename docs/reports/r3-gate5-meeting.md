# Round 3 — Gate 5: Meeting security & lifecycle (2026-08-30)

**Status: CODE + TESTS + real-socket smoke PASS · live Google Meet run BLOCKED_BY_RECALL_KEY (+ BLOCKED_BY_RECALL_PUBLIC_URL).** Nothing is faked: the smoke test mocks only Recall's REST API; every token/websocket/HTTP check ran against the real broker code over real sockets.

## Threat model — what the signed session token prevents
| Threat | Before | Now |
|---|---|---|
| Anyone who learns the Output Media URL loads our bot page and impersonates the character (or points it at any `botId`) | URL carried `botId`, character, persona, engine in the clear; no auth | URL carries only a **signed, ≤15 min, single-use** `bot_page` token; `POST /api/meeting/session/activate` burns the nonce → second load = `401 replayed`; render config (character/persona/engine/name) is served from the registry, never from the query |
| Replay of a captured bot-page URL after the bot restarted | possible | nonce burned per activation; operator must explicitly `refresh` to issue a new one (audited via `activations`) |
| Forged / expired / cross-session tokens | n/a | HMAC-SHA256 (timing-safe compare), `exp`, `role`, `sid`↔`botId` binding checked on upgrade, on every relay message, and every 10 s on client sockets |
| A browser subscribing to another bot's relay feed | any client could open `/client/{botId}` | `client` token must belong to the session bound to that `botId` → `401 bot_mismatch` |
| Recall (or anyone) connecting to a relay endpoint with a guessed token | UUID token only | signed `relay` token (6 h) + registry check; revoke/end closes the socket (1008) |
| Session left open after the bot leaves / the meeting ends | manual | `leave`, `done|fatal|call_ended` polls and TTL sweeper end the session: tokens → `401 ended`, relay clients dropped |
| Operator actions without proof of ownership | none | `refresh` / `revoke` / status require `Authorization: Bearer <clientToken>` of the same session (`403 session_mismatch` otherwise) |
| Two bots joining the same meeting by mistake | possible | `409 DUPLICATE_JOIN` (URL normalised) unless `force: true` |

Secret: `MEETING_TOKEN_SECRET` (≥16 chars) in `services/token-broker/.env`; unset → ephemeral secret with a startup warning (tokens die on restart).

## Lifecycle coverage matrix (`MeetingLifecycle` + `RecallSession`, fixtures in `connectors/recall/fixtures/`)
| Scenario | Recall signal (docs.recall.ai sub-codes) | Lifecycle | Behaviour | Test |
|---|---|---|---|---|
| waiting room | `in_waiting_room` | `waiting_room` | no outbound audio; UI「待機室（承認待ち）」 | lifecycle.test / recall lifecycle.test |
| admitted | `in_call_not_recording` / `in_call_recording` | `admitted` | `joined` event, policy active | ✓ |
| denied | `call_ended/bot_kicked_from_waiting_room`, `timeout_exceeded_waiting_room`, `fatal/google_meet_knocking_disabled` … | `denied` | `left` event, cleanup, UI「入室が拒否されました」 | ✓ (3 fixtures) |
| host mute | `setAudioMuted` / best-effort `participant_events.update{is_self, muted}` (Recall documents no mute event) | flag | outbound audio dropped, speech held, policy reset, `audio_muted` event, UI「ミュート中」 | ✓ |
| bot removed | `call_ended/bot_kicked_from_call` | `removed` | cleanup; stale `in_call_recording` polls ignored | ✓ |
| network reconnect | relay ws close after admission | `reconnecting` → `admitted` (backoff 1/2/4/8 s, 60 s budget) → `failed` | outbound held, policy reset on resume, UI「再接続中…」 | ✓ (fake timers) |
| meeting ended | `call_ended/call_ended_by_host|…idle|…everyone_left`, `fatal/meeting_ended` | `ended` | cleanup | ✓ |
| duplicate join | same meeting URL live | broker `409 DUPLICATE_JOIN` | operator must leave or `force` | app.test + smoke |
| output media failure | no bot-page activation ≤ 20 s after admission | retry once (`POST …/output_media/restart`, fresh single-use token) → `failed` | ✓ (fake timers + broker route test) |
| our leave | `leave()` / `call_ended/bot_received_leave_call` | `left` | idempotent, tokens ended | ✓ |
| fatal | `fatal/*` (non-denied) | `failed` | cleanup | ✓ |

## Files
- `packages/meeting-core/src/lifecycle.ts` (+ `lifecycle.test.ts`, 18 tests), `types.ts` (`MeetingStatus` + `audio_muted` event), `index.ts`
- `services/token-broker/src/meeting-session.ts` (registry + HMAC tokens, + `meeting-session.test.ts` 11 tests), `meeting-ws-auth.ts` (pure upgrade auth), `routes/meeting.ts` (session-aware create/activate/refresh/revoke/status/leave/restart), `meeting-relay.ts` (`dropBot`), `server.ts` (auth on upgrade, per-message re-verify, 10 s client guard, TTL sweeper), `app.ts`, `env.ts`, `.env.example`, `app.test.ts` (+5 security tests), `scripts/smoke-meeting-security.ts`
- `connectors/recall/src/RecallConnector.ts` (lifecycle-driven session: reconnect backoff, output-media watchdog, mute gating, bot binding on relayed frames, idempotent leave/cleanup), `protocol.ts`, `botPage.ts` (`parseBotPageParams` token form, `peekBotPageToken`, `activateBotPage`), `fixtures/{status-webhooks,bot-status-poll}.json`, `lifecycle.test.ts` (11 tests), `recall.test.ts` updated
- `apps/web/src/App.tsx` (token-only bot params), `screens/Meeting.tsx` (activate-once flow, server-side render config, new statuses, mute indicator), `session/MeetingSessionController.ts` (activation handoff, status/mute gating, policy reset on reconnect, teardown on terminal states)
- `docs/integration-contracts.md` (Meeting section), `vitest.config.ts` (**out of scope, additive**: `connectors/**/*.test.ts` was missing from the root include, so the connector tests never ran in `pnpm test`)

## Commands & results
- `pnpm vitest run packages/meeting-core` → 43 passed · `pnpm vitest run connectors/recall` → 20 passed · `pnpm vitest run services/token-broker` → 31 passed · `pnpm vitest run apps/web` → 11 passed
- `pnpm -r typecheck` → clean · `pnpm vitest run` (whole repo) → **34 files / 295 tests passed**
- Real-socket smoke `pnpm --filter @rcai/token-broker exec tsx scripts/smoke-meeting-security.ts` (broker on :8797, Recall REST mocked):

| check | result |
|---|---|
| POST /api/meeting/recall/bots | 200, bot page URL = `…/?rcai_bot=1&token=<signed>` (no botId/character) |
| duplicate join (same meeting URL) | 409 DUPLICATE_JOIN |
| client ws without token | 401 token_required |
| client ws with valid client token | 101 open |
| client ws with token for another botId | 401 bot_mismatch |
| relay ws with bogus token | 401 malformed |
| bot page activate (first load) | 200 `{"character":"yui","persona":"friend_ja"}` |
| bot page activate (replayed URL) | 401 replayed |
| session status without / with operator token | 401 / 200 activations=1 |
| refresh bot page token (operator) | 200 (new single-use URL) |
| revoke session (operator) | 200 |
| client ws after revoke | 401 revoked |
| bot page activate after revoke (fresh token) | 401 |
| leave → client ws after leave | 200 → 401 ended |

## Known limits
- Host-mute detection: Recall documents no mute event; the connector exposes `setAudioMuted()` and maps `participant_events.update` with `is_self` + `muted|audio_muted|is_muted` best-effort. Must be verified on a live bot.
- Output-media failure is inferred (no activation within 20 s) because Recall documents no failure webhook for Output Media.
- The bot page trusts the `brk` (broker URL) peeked from the token only to know where to send the token; the broker's signature check is the authority.

## BLOCKED_BY_RECALL_KEY — the live gate
Once `RECALL_API_KEY`, `RECALL_REGION`, `RECALL_PUBLIC_URL` (broker tunnel), `RECALL_BOT_PAGE_URL` (web tunnel) and `MEETING_TOKEN_SECRET` are in `services/token-broker/.env`:
```
pnpm dev                                   # web 5173 + broker 8787 + agent 8788 (behind ngrok/cloudflared tunnels)
MEET_URL=https://meet.google.com/xxx-xxxx-xxx pnpm --filter @rcai/connector-recall e2e:meet
```
or 「会議に参加」in the web app. Expected evidence: activation #1 logged on the bot page, waiting-room → admitted timeline, `401 replayed` if the URL is reopened, revoke from the operator UI closes the bot feed.
