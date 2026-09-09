# Live cost optimization — 2026-09-10 JST

## Implemented behavior

- Gemini defaults explicitly to `TURN_INCLUDES_ONLY_ACTIVITY` and context compression trigger 10,000 / target 3,000. Existing speech VAD and onset pre-roll are preserved. `legacyCostPolicy` is a harness-only baseline option.
- Attendee meeting mode uses platform captions as an independent observer. A bot-bound, expiring callback credential forwards captions to that bot's relay. Wrong-role, wrong-bot, revoked credentials and duplicate deliveries are rejected; unavailable listeners cause a retryable response. No transcript is written to the new cost logs.
- The observer opens Live only for a sanctioned text turn, and disconnects 30 seconds after interaction ends. A stalled generation is bounded at 60 seconds. One-to-one personas retain the continuous conversation path. The operator can choose audio listening when platform captions are unavailable.
- The meeting application retains bounded, extractive decision/task/concern quotes and the current topic. It injects these plus up to six recent utterances when waking Live. This is in-memory, per-meeting evidence, not durable minutes or an inferred owner/deadline database.
- Live input transcription is disabled on the observer path. Output transcription remains for Yui's captions. Attendee defaults to platform captions rather than an additional paid Deepgram transcription; explicit Deepgram requests remain supported.
- Gemini images are event-driven snapshots on detected gestures, at most once per five seconds for the engaged participant. No continuous camera upload is enabled by default. Spoken replies are prompted toward 5–10 seconds, within 15 seconds unless detail is requested; this is a prompt, not an audio truncation limit.
- Meeting UI shows an estimated AI cost separately from vendor credits, with observed connection/audio duration, image count and peak input context. Unknown pricing is not shown as a free response. The provider supplied no exact compression count or input/output-transcription-only breakdown; these remain unavailable.

## Pricing and observation

Vertex's actual Live response uses `candidatesTokensDetails` on this deployment. Both that field and `responseTokensDetails` are supported. Interim metadata is replaced; a completed/interrupted response is priced once, including its full input context. Repeated operational checkpoints are never added together.

The supported model is `gemini-live-2.5-flash-native-audio`. USD per million tokens: text input 0.50; audio/image/video input 3; text output 2; audio output 12. Estimates exclude tax, currency conversion, discounts, other models, bot charges and infrastructure. Missing or unreconciled modality counts are marked unpriced.

Content-free `vertex_live_usage` logs record actual transport counters per connection. Authenticated bot-page `meeting_ai_usage` reports associate cumulative estimates with the meeting session ID, on responses, at most once per minute while idle, and on cleanup. Use the latest/max cumulative values per session, not a sum of reports. No fabricated user identity is added; the application does not yet offer a durable per-user billing ledger.

## Validation

The real Vertex lifecycle probe accepted the new setup and passed connection, resumption, cancellation and leave checks. An initial health probe hit its three-second timeout; the later probe succeeded after the service was warm.

The bounded context-pressure probe observed input counts `2790, 5100, 7411, 9722, 2790, 5147, 7525, 2790, 3081`. After those drops, a task quote supplied from application memory yielded the correct synthetic owner and deadline. Nine priced responses cost an estimated **$0.0322165**. Context drops are observed; an exact compression counter is not claimed.

The 30-minute baseline/observer replay is a synthetic Vertex experiment, not a Meet/Zoom session. Both receive the same scheduled question and the same fixture-derived meeting memory; baseline additionally receives every paced room-audio utterance. Observer captions are fixture data, so the experiment does not measure real caption accuracy or delay, platform fees, or human quality. Baseline uses the previous window/coverage policy but the same short-response prompt. The combined comparison does not isolate compression from observer savings. Numerical completion results are recorded separately after the runs finish.

Actual Meet/Zoom comparison still requires a current test room. Google Cloud Billing currently shows September 1–7 coverage; this new experiment cannot yet be reconciled against that report. No Release=GO claim follows from these tests.

## Official references

- [Vertex Live context configuration](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/start-manage-session)
- [Vertex Live TurnCoverage](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live)
- [Live context rebilling](https://ai.google.dev/gemini-api/docs/live-api/best-practices#pricing-and-billing)
- [Vertex public rates](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Attendee captions and transcription](https://docs.attendee.dev/guides/transcription)
- [Attendee callback format](https://docs.attendee.dev/guides/webhooks)

To reproduce the synthetic replay, generate the documented Japanese fixture with local macOS `say`, convert to 16 kHz mono PCM16 at `/tmp/ai-meeting-cost-ab/input.pcm`, then run `scripts/reality/cost-ab.ts` with `BROKER_URL`, `OUT`, and `VARIANT=baseline` or `optimized`. The script creates paid AI sessions for up to 1,800 seconds and closes them in `finally`; it stops if its usage safety bound is exceeded. It does not join a meeting or create a bot.
