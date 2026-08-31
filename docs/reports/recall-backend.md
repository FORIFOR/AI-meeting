# Recall.ai backend core — token-broker (2026-08-31)

Workspace **NEXT-STANDARDS** `13636071-5bda-4018-adaf-55c71fa4003a`, region **ap-northeast-1**, API **v1.11**,
dashboard webhooks signed with the **workspace verification secret** (`get_info` →
`dashboard_secret_source: workspace_verification_secret`).

The backend owns every Recall credential. Nothing in `apps/web` ever sees the API key or the
verification secret; the browser only talks to this broker.

## Lifecycle implemented

```
POST /api/meeting/recall/bots
   └─ store.createIntent()            ← persisted BEFORE the Create Bot call (guide step 5)
   └─ RecallClient.createBot({ meeting_url, bot_name, join_at?, metadata.meetingRecordId })
   └─ store.update(botId, joining_call)

Recall ──► POST /api/recall/webhooks  (Svix, signed)
   └─ verify RAW body ─ reject 401 before parsing ─ else enqueue + 2xx immediately
        bot.*              → lifecycle on the meeting record
        recording.done     → RecallClient.createTranscript(recallai_async, language auto,
                             diarization.use_separate_streams_when_available) — once per recording
        transcript.done    → retrieveTranscript → data.download_url → downloadJson → persist
                             (JSON + readable text) on the meeting record
        transcript.failed  → record data.status.sub_code

GET /api/meetings · /api/meetings/:id · /api/meetings/:id/transcript   ← the persisted product output
```

No polling anywhere; a recording gets at most one transcript request (Recall caps this at 10 live /
100 attempted). Ambiguous Create Bot failures mark the intent `create_failed` and are reconciled on
the next attempt for the same meeting URL instead of being blindly retried.

## Files

| File | Purpose |
|---|---|
| `services/token-broker/src/recall/client.ts` | region-bound API client (`createBot`, `retrieveBot`, `leaveCall`, `createTranscript`, `retrieveTranscript`, `downloadJson`); raw `Authorization` header; `Retry-After` on 429, jittered backoff on 503/507; injectable `fetch`/`sleep`/`random` |
| `services/token-broker/src/recall/verify.ts` | `verifyRequestFromRecall` exactly per the docs (webhook-id/timestamp/signature, `svix-*` aliases, `${id}.${ts}.${rawBody}`, multi-signature rotation, timing-safe, 5-min tolerance) + `signLikeRecall` for tests/smoke |
| `services/token-broker/src/recall/store.ts` | durable meeting records (atomic tmp+rename), transcript persistence, `toReadableTranscript` |
| `services/token-broker/src/recall/queue.ts` | file-backed job queue, idempotency on `webhook-id`, bounded retries → dead-letter, background worker |
| `services/token-broker/src/routes/webhooks.ts` | verified-event handlers for the 12 dashboard events |
| `services/token-broker/src/routes/meeting.ts` | intent-before-bot ordering, `join_at`, `metadata.meetingRecordId`, leave updates the record |
| `services/token-broker/src/app.ts` | `POST /api/recall/webhooks` + `GET /api/meetings…` wiring (additive) |
| `services/token-broker/src/env.ts`, `.env.example` | `RECALL_WEBHOOK_VERIFICATION_SECRET`, `RECALL_TRANSCRIPT_LANGUAGE`, `RECALL_DATA_DIR` |
| `services/token-broker/scripts/smoke-recall-webhooks.ts` | real-HTTP smoke (`pnpm --filter @rcai/token-broker smoke:recall`) |

Logging is redacted by construction: only `{verified, event, webhookId, meeting, transcriptId, subCode}`
are logged — never headers, bodies, transcript content or credentials.

## Commands and results

```
pnpm --filter @rcai/token-broker typecheck        → clean
pnpm vitest run services/token-broker             → 3 files, 54 tests passed (23 new)
pnpm vitest run                                   → 37 files, 358 tests passed (nothing regressed)
pnpm --filter @rcai/token-broker smoke:recall     → SMOKE OK
```

New tests cover: signature accept/reject (wrong secret, tampered body, missing headers, stale
timestamp, `svix-*` aliases, rotation with several `v1,` signatures, body-less GET/upgrade),
region + auth header, `Retry-After` honoured, jittered backoff then typed failure, exact
`create_transcript` body, queue idempotency and dead-lettering, `recording.done` → one transcript,
replay → none, `transcript.done` → retrieve/download/persist, `transcript.failed` → sub_code,
webhook route 401 without processing, duplicate redelivery, `/api/meetings*` output, 503 without a
secret, intent-before-create ordering, and `join_at`/metadata propagation.

## Smoke output (real HTTP boundary, Recall API stubbed by a local fixture)

```
verification secret loaded: whsec_… (70 chars, not printed)
meeting record mtg_a4bbf876-… → status=joining_call
unsigned POST → 401 (expected 401)          [recall] webhook rejected {"verified":false,"reason":"missing_headers"}
POST … bot.in_call_recording → 200 {"ok":true,"duplicate":false}
POST … recording.done        → 200 {"ok":true,"duplicate":false}   → transcriptId t_smoke_1
POST … transcript.done       → 200 {"ok":true,"duplicate":false}   → 59 bytes persisted
POST … transcript.done (replay) → 200 {"ok":true,"duplicate":true} → no second call
store transitions: intent → bot_created → bot.in_call_recording → recording.done → transcript.requested → transcript.done
GET /api/meetings/:id/transcript →
[00:02] Shuhei: 本日はよろしくお願いします
[00:05] Yui: こちらこそ、よろしくお願いします
SMOKE OK
```

## Still blocked

- **Registering the dashboard webhook endpoint** needs a stable public URL
  (`RECALL_PUBLIC_URL`, ngrok reserved domain in progress). Once it exists, the endpoint URL is
  `https://<stable-host>/api/recall/webhooks` and it should subscribe to exactly:
  `bot.joining_call, bot.in_waiting_room, bot.in_call_not_recording, bot.recording_permission_allowed,
  bot.recording_permission_denied, bot.in_call_recording, bot.call_ended, bot.done, bot.fatal,
  recording.done, transcript.done, transcript.failed`.
- No real bot has been sent to a meeting from this code path yet; the smoke proves the receiving
  side only.
