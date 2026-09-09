# Input usage follow-up — 2026-09-09

The production provider defaults to speech-gated audio. Application code does not override it to a continuous stream. A mock-transport test was extended from 800 ms to 60 seconds of low-level artificial silence: zero audio messages were forwarded by the default gate, versus 3,000 messages when continuous mode was explicitly selected. This is a local transport test, not a claim about recognition, real room noise or billed cost. Existing speech onset/pre-roll behavior was left intact.

Gemini setup already requests session resumption and sliding-window context compression. Therefore this investigation did not disable history, raise voice thresholds or discard more audio merely to claim a savings percentage. Provider billing snapshots and transmitted audio are different quantities; prior billing alone cannot attribute the cost to silence, history reprocessing or leaked connections.

## New server observations

Vertex Live relay logs a structured `vertex_live_usage` observation every 60 seconds and on client closure. Each connection has a random observationId. Fields include model, elapsed milliseconds, forwarded PCM bytes/seconds, unrecognized audio encoding count, realtime text character count, number of provider usage snapshots and the latest numeric provider counters. Initial setup text/clientContent are not included in realtime text character count. No audio, transcript, prompt, URL, credential or raw provider object is logged.

Checkpoints are cumulative for a connection; **never sum checkpoints**. Use the final `closed` observation per observationId for completed transport totals. The latestProviderUsage field is a snapshot, not an incremental charge; neither sum repeated snapshots nor treat it as a reconciled invoice. Missing modalities, unexpected encodings and abruptly terminated containers can leave incomplete observations. A recent checkpoint is not independent proof that a human is present.

Operational Cloud Logging filter:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="ai-meeting-broker"
jsonPayload.event="vertex_live_usage"
```

Use `jsonPayload.phase="closed"` when analyzing completed connections. Compare provider counters with actual transmitted audio only as diagnostic evidence. Billing remains authoritative, with its reporting delay and applicable model prices.

Validation: 39 initial tests passed (36 Gemini provider tests plus 3 observation tests). The expanded 60-second-silence test was then run with the full 36-test Gemini file and passed. Broker typecheck passed. No paid AI connection or real meeting was created for this change; production log generation awaits the next authorized use. This adds diagnostic visibility, not a hard spending cap or a proven reduction in the historical bill.

Source `aba5280` was built successfully by Cloud Build `2b11b698-d3ec-408f-ac4a-d4195204bf7e` and deployed to Cloud Run revision `ai-meeting-broker-00016-9gc` with 100% traffic. Existing environment and secrets were preserved. Read-only /health returned HTTP 200 with Google available; no AI session was created to verify logging. Frontend unchanged.
