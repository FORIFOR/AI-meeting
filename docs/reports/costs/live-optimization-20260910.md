# Live cost optimization — 2026-09-10 JST

## Implemented behavior

- Gemini defaults explicitly to `TURN_INCLUDES_ONLY_ACTIVITY` and context compression trigger 10,000 / target 3,000. Existing speech VAD and onset pre-roll are preserved. `legacyCostPolicy` is a harness-only baseline option.
- Attendee meeting mode offers platform captions as an **opt-in, experimental** independent observer. It is not selected automatically because quality validation below did not pass. A bot-bound, expiring callback credential forwards captions to that bot's relay. Wrong-role, wrong-bot, revoked credentials and duplicate deliveries are rejected; unavailable listeners cause a retryable response. No transcript is written to the new cost logs.
- The observer opens Live only for a sanctioned text turn, and disconnects 30 seconds after interaction ends. A stalled generation is bounded at 60 seconds. One-to-one personas retain the continuous conversation path. The operator can choose audio listening when platform captions are unavailable.
- The meeting application retains up to 256 extractive quotes per decision/task/concern category (160 characters each) and the current topic. It selects up to four relevant/recent quotes per category plus up to six recent utterances when waking Live; an excerpt is explicitly marked as incomplete. A lexical retrieval test preserves an old owner/deadline after 30 newer tasks. This is in-memory, per-meeting evidence, not durable minutes or an inferred owner/deadline database.
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

The 30-minute baseline/observer replay is a synthetic Vertex experiment, not a Meet/Zoom session. Both receive the same scheduled question, fixture-derived meeting memory, and paced room-audio frames. The observer wrapper forwards frames only while active. The full controller policy gate is not simulated; real platform behavior still needs verification. Observer captions are fixture data, so the experiment does not measure real caption accuracy or delay, platform fees, or human quality. Baseline uses the previous window/coverage policy but the same short-response prompt. The combined comparison does not isolate compression from observer savings. An initial observer replay omitted even engaged audio and is excluded from the paired result; its cost is retained as an exploratory run. The corrected observer replay forwards engaged audio. Completed numeric results are in `live-cost-replay-20260910.json`.

Actual Meet/Zoom comparison still requires a current test room. A fresh Google Cloud Billing read on September 10 JST shows September 1–8 coverage, ¥5,229 net total, and unchanged Live SKU usage versus the earlier snapshot. This new experiment cannot yet be reconciled against that report. No Release=GO claim follows from these tests.

## Official references

- [Vertex Live context configuration](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/live-api/start-manage-session)
- [Vertex Live TurnCoverage](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live)
- [Live context rebilling](https://ai.google.dev/gemini-api/docs/live-api/best-practices#pricing-and-billing)
- [Vertex public rates](https://cloud.google.com/vertex-ai/generative-ai/pricing)
- [Attendee captions and transcription](https://docs.attendee.dev/guides/transcription)
- [Attendee callback format](https://docs.attendee.dev/guides/webhooks)

To reproduce the synthetic replay, generate the documented Japanese fixture with local macOS `say`, convert to 16 kHz mono PCM16 at `/tmp/ai-meeting-cost-ab/input.pcm`, then run `scripts/reality/cost-ab.ts` with `BROKER_URL`, `OUT`, and `VARIANT=baseline` or `optimized`. The script creates paid AI sessions for up to 1,800 seconds and closes them in `finally`; it stops if its usage safety bound is exceeded. It does not join a meeting or create a bot.

The final local suite passed **775 tests in 84 files**. Workspace TypeScript checks and the production web build passed. These establish software regression coverage, not real conference or human acceptance.

The completed baseline replay lasted 1,800.011 seconds: 71 priced responses, no unpriced observations, **$3.174756**, 31,698 peak input tokens, 609.24 sent audio seconds, and 486.81 received assistant audio seconds. The simple 20-second owner/deadline mention check passed 9/12 queries; this is not a full correctness or latency evaluation. Four connections and six error events were recorded; the aggregate error counter does not distinguish normal renewal notifications from faults. The run completed and disconnected.

## Deployment during validation

Frontend source `5d259d8` was published as Firebase Hosting version `5c76c8af6781067e` at 2026-09-09 16:18:33 UTC. Public HTML and its entry JavaScript match the local build byte for byte. Broker source `c746dd8`, image digest `sha256:72ff7653a729ff4acdaf51187a4f6ec89825fb3705d57e372c2b443370dcfabd`, was deployed to `ai-meeting-broker-00017-s7f` with 100% traffic; health returned 200. The corrected observer replay was still running during this deployment. Model and client experiment settings were unchanged, but this infrastructure change is a confound and the result is not a strictly controlled pre/post trial.

## Completed comparison and release decision

| Synthetic 30-minute replay | Baseline | Corrected observer wrapper |
|---|---:|---:|
| Public-rate AI estimate, USD | 3.174756 | 1.0102665 |
| Priced / unpriced responses | 71 / 0 | 67 / 0 |
| Peak input tokens | 31,698 | 9,698 |
| Live connection seconds | 1,800.294 | 1,679.645 |
| Sent audio seconds | 609.240 | 566.080 |
| Received assistant audio seconds | 486.810 | 258.692 |
| Owner + deadline mention within 20 seconds | 9 / 12 | 4 / 12 |

The **68.18% lower estimated AI cost does not establish preserved quality**. Scheduled text questions overlap room audio in this provider-level harness, so interrupted answers can affect the mention check. The actual controller's speech gate and real final-caption timing are absent. Do not extrapolate the percentage to actual meetings or claim a seven-minute Live duration: the corrected audio stress run kept Live active for about 28 minutes. The retired text-only observer experiment's $0.021322 / 445-second result is not the production audio comparison.

Accordingly, caption observation is **off by default** and marked as trial availability in the UI. Explicit selection remains possible. ONLY_ACTIVITY, 10,000 / 3,000 compression and event-driven images remain default optimizations. No model migration was performed. A current real meeting URL, real caption timing/accuracy tests and human evaluation are required before making observation the default or declaring Release=GO.

The excluded 28-minute baseline attempt cost $2.645260; the retired observer approximation cost $0.021322. All four listed replays plus the context-pressure and final audio-duration probes total **$6.884836 estimated AI cost**. This excludes the earlier lifecycle probe and non-AI charges; it is not an invoice.

## Final deployment and targeted verification

- Final frontend source: `5f7d745`; Firebase version `602097dfe3a0e695`, published 2026-09-09 16:42:20 UTC. Caption observation is explicitly opt-in.
- Final broker source: `9909a03`; Cloud Run revision `ai-meeting-broker-00018-r7r`. A real response used bare `audio/pcm`; the earlier strict rate parser missed its duration. The broker now follows the provider/player's 24 kHz output default and accepts additional MIME parameters.
- The final short response yielded 2.51154 client seconds and 2.512 server seconds; both estimated $0.001015 for one response with no unpriced observations. Its connection was closed. The new cloud counter is verified, not merely unit tested.
- After the 775-test suite, the duration change passed its six related tests and broker typecheck; the opt-in change passed 18 controller/observer tests and the production build. Invalid observer credentials returned 401 on the deployed endpoint.
- Google Billing still cannot reconcile these new September 9 UTC calls against its September 1–8 display. Release remains NO-GO for the outstanding conference/quality evaluation, rather than inferred GO from cost savings.
