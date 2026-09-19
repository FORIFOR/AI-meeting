# Conversation-time reference cues

## Inspiration and scope

Reference supplied by the maintainer: <https://x.com/rinte0321/status/2100736454850908344> (Rinte, September 18, 2026 JST). The described EC demo combines Jev with a live voice model to update recommendations during speech and vary an avatar's expression. AI Meeting adapts those interaction ideas to **existing project references**, not to product sales. The demo's implementation code or video assets are not copied. This feature is not a reproduction or benchmark of that demo.

The regular one-to-one/project **Session** screen now has a compact conversation-hint panel. Partial user transcripts are evaluated independently from the voice response. It can surface a confirmed task, saved decision, open question or next step from the current workspace. Candidate labels are never invented. The panel does not automatically save notes, change tasks, approve changes, invoke tools or create calendar events.

External Meet/Zoom bot pages use a separate MeetingSessionController. This change does not add the panel to those pages. It also does not change the voice provider or select a different voice model.

## Two clearly labelled paths

- **Local (default):** bounded keyword/bigram reference matching, no extra network request, API key or login. It is a deterministic heuristic, not Jev running on-device. No numeric AI confidence is claimed. The hint can be wrong, especially for ambiguous, negated or incomplete speech.
- **Jev (optional):** one typed System One request asks for a reference choice and conversational intent together. The broker validates the exact label set, probability range/sum, selected winner, confidence and margin. Low-confidence output yields no reference or expressive intent. These thresholds are provisional engineering choices, not a calibrated accuracy guarantee.

Official API contract: <https://github.com/typesafe-ai/typesafe-sdk-js/blob/main/src/types.ts> and <https://docs.typesafe.ai/api>. The adapter uses `POST https://api.typesafe.ai/v1/systemone`, with a server-held bearer key and the documented `state`, `questions`, `answers` contract. The documented default alias `jev-latest` is used unless the operator supplies a validated model through `TYPESAFE_DEFAULT_MODEL`. No new SDK or dependency is bundled.

## Privacy and enablement

Jev is disabled by default and always refused by the public hosted/demo profile. The browser does not offer it for strict_local or team sessions. Enabling it for a self-hosted, single-operator evaluation requires:

```dotenv
# services/token-broker/.env (never commit the real values)
RCAI_LIVE_CUES_ENABLED=1
TYPESAFE_API_KEY=YOUR_SERVER_ONLY_TYPESAFE_KEY
TYPESAFE_DEFAULT_MODEL=jev-latest
RCAI_LIVE_CUES_TOKEN=YOUR_RANDOM_SEPARATE_32_OR_MORE_CHARACTER_CAPABILITY
RCAI_LIVE_CUES_ORIGIN=http://localhost:5173
```

Generate the decision-only capability independently (for example `openssl rand -hex 32`). Never reuse the TypeSafe API key, a Firebase token, an administrator token or a GitHub credential. The browser's Jev settings accept **only this narrow decision capability**. Possession permits metered advisory requests within this process's limits, so distribute it only to the trusted operator. This is not multi-tenant production authorization.

The user must explicitly confirm the displayed broker origin and consent to sending the latest utterance text (at most 800 characters) plus at most 12 candidate labels (160 characters each) to TypeSafe through that broker. No audio, video, full transcript, complete project memo, authentication account details, or calendar tokens are included. The new layer does not persist or log the utterance. Existing voice-provider behavior is unchanged. TypeSafe's own processing/retention terms still apply.

Consent/capability are memory-only and scoped to the current broker/privacy context. Changing the broker or privacy mode invalidates consent. Turning hints off, muting or ending the session aborts pending work. Default local processing also works in strict_local; there is no automatic cloud fallback.

## Responsiveness, cancellation and spend

The voice runtime never waits for a cue. Local updates are debounced approximately 180 ms and rate-limited to 200 ms; remote requests are at most once per second with a 1.6-second client deadline and 1.5-second upstream deadline. These are configured scheduling budgets, **not measured model latency**. There is no promise that a model response arrives within that budget.

A newer partial transcript/correction invalidates old work immediately. Late responses cannot restore the previous hint. Failure switches to explicitly labelled local matching without an automatic retry. A remote scheduler allows at most 300 calls per instance; the broker allows one in-flight call, at least one second between calls and 300 attempted calls per process lifetime. Failed calls consume capacity. These limits reset on process restart and multiply across replicas: **they are not a monetary/provider billing cap**. Use a dedicated single-instance evaluation and provider-side spending limits. There is no automatic capacity expansion.

Avatar changes express a conversational intent (exploring, thanking, clarifying), not a diagnosis of a person's feelings. They are subtle, optional, default off when reduced-motion is requested, and only applied while idle/listening/interrupted. They cannot trigger speech, change the turn state or approve an operation. Old gestures/transcripts are not replayed.

## Tests and unverified boundaries

Added regression coverage exercises typed results, malformed/invented choices, confidence gating, input size limits, partial speech debouncing, correction cancellation, timeout fallback, scoped consent, strict/team blocks, broker origin/capability checks, bounded upstream calls, actual route registration and controller expression-only behavior. The normal full CI suite and OSS distribution audit remain required before merging.

The TypeSafe HTTP responses and audio-device boundaries in automated tests are fixtures. A real Jev account, live TypeSafe request, physical microphone, 30-minute human conversation, actual model speed/accuracy and production deployment are **not established** by these tests. No paid external request is required by CI. To accept the live integration, a trusted operator must configure the server, consent in the session panel, verify that the source badge changes to Jev, speak/correct reference topics and confirm that disabling the feature stops requests. Record observed timings separately from configured deadlines.
