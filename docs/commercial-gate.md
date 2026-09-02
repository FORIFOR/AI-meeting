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
| 4 | Fatal sub-codes as operator-readable errors | **PASS** | `describeBotFailure` covers `google_meet_bot_blocked`, `knocking_disabled`, `organisation_restricted`, `login_not_available` and the rest, never blanks out on a code Recall adds later, and the meetings screen shows the reason **and the fix** rather than 「参加できませんでした」. |
| 5 | Participants told an AI is listening | **PASS (code), UNVERIFIED LIVE** | `chat.on_bot_join` notice; shape from Recall's reference, never exercised — the workspace ran out of credit first. Confirmed by a human in the smoke gate. |
| 6 | 402 / 507 are operational states, not outages | **PASS** | `BLOCKED_BY_RECALL_CREDIT` and `BLOCKED_BY_RECALL_CAPACITY`. |
| 7 | Usage visible, empty account visible | **PASS** | `GET /api/recall/usage` reports billed bot hours (`bot_total` is seconds — 14053.27 matched 3.90 billed hours). Remaining credit is not exposed by the API, so `/health` carries `meeting.creditRefusedAt`: the first refusal is visible to operations instead of waiting for a user whose meeting did not happen. Auto top-up remains a dashboard setting. |
| 8 | **10-minute smoke with real people** | **BLOCKER** | Two attempts on Attendee, 2026-09-02. Both reached the meeting: admitted, avatar rendered, webhook lifecycle complete, audio and transcripts flowing. **Attempt 1** (`bot_hnPC8GruiRzkHXQ2`) aborted at ~3 min — the page routed to OpenAI, no credit, seen and silent (429 in-call). **Attempt 2** (`bot_q21wV6BfaY1hHiq4`, Gemini) ran the full 10 minutes: page started, 56,266 audio chunks, 45 utterances, lifecycle PASS — and `addressed by name` **0**, so `character produced speech` **0.0 s**. The person did call the name six times; the recogniser wrote 「ゆイ」 and the matcher is literal. Both causes fixed and measured against that meeting's own transcripts (0 → 2 addressed). Re-run required. |
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

Proved automatically: a dropped delivery leaves the record stale, reconcile recovers it, and a reconcile
that would move the state backwards is refused. Worth repeating once in a live call.

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
| Missed webhook → reconcile → correct state | **PASS (automated)** — a dropped delivery leaves the record stale; reconcile puts it right and records `reconcile:<status>`; a reconcile that would move it backwards is refused. Still worth repeating once in a live call. |
| Empty account visible to operations | **PASS** — `/health` → `meeting.creditRefusedAt`. |
| Auto top-up configured | Operator action (dashboard setting; not an API) |
| `ATTENDEE_WEBHOOK_SECRET` set | Operator action. The signing secret is **project-level and dashboard-only** — Attendee generates it server-side (`WebhookSecret`, Fernet-encrypted) and no API returns it. Copy it from `app.attendee.dev/projects/<project>/webhooks/` → **Copy Secret**. Until it is set, deliveries are recorded as unverified rather than silently trusted. |
| Bot admitted within 15 minutes | Operational limit, not a bug: the bot-page token's TTL is 15 min (`TOKEN_TTL_MS.bot_page`). A bot left in the waiting room longer than that joins without its avatar page — and waiting-room time is billed. |

## Meeting providers

The connector boundary exists so the meeting vendor is a decision, not an architecture. Two are
implemented; which one is better is a measurement.

| | Recall | Attendee |
|---|---|---|
| Character's voice out | Output Media (a web page as the camera) | the same socket the audio arrives on |
| Avatar (Live2D needs WebGL) | `web_gpu` only, **$1.50/h** | **works** — the webpage streamer rendered Live2D on the Meet tile in the first live run, at the base rate. |
| Base rate | $0.50/h | $0.50/h after 5 free hours |
| Audio rate | 24 kHz out of the box | 8/16/**24** kHz — 24 matches our TTS, no resampling |
| Verified here | join, avatar, transcripts, lifecycle, 30-min soaks | create-bot and the audio contract (unit-tested); **never run against a live meeting** |

What is verified for Attendee comes from the API docs and the vendor's own example:
`POST https://app.attendee.dev/api/v1/bots`, `Authorization: Token <key>`,
`websocket_settings.audio { url, sample_rate }`, `realtime_audio.mixed` in and
`realtime_audio.bot_output` out. What is **not** verified is `voice_agent_settings` — the field that
renders the Live2D page as the bot's camera. It is sent whenever `RECALL_BOT_PAGE_URL` is configured
(and `ATTENDEE_VOICE_AGENT` is not `off`), always with `reserve_resources: true`, which is the switch
Attendee actually reads. The avatar claim stays unproven until a real call.

The saving is real: the avatar at the plain rate, ~$50 instead of ~$150 per 100 hours. Live2D rendered
on Attendee's streamer in the first live run, so the GPU surcharge Recall charges for `web_gpu` buys
nothing Attendee does not already do. Attendee's free 5 hours cover the 10-minute smoke and the
30-minute gate roughly seven times over.

## Perception (added 2026-09-02)

The character reads the room as well as hearing it: Attendee's per-participant webcam at 360p/2 fps →
MediaPipe Face Landmarker in the bot page → cues (nod, head shake, tilt, smile, gaze) → the
participation policy and, optionally, the conversational model.

| Claim | State |
|---|---|
| The face model runs in a browser | **Measured** — 117 ms to load, 13 ms median frame under software rendering, against a 500 ms budget at 2 fps. |
| It reads a real face | **Measured** — 52 blendshapes and a 4×4 transformation matrix from a frame cut out of a real meeting recording. |
| It needs WebGL | **Measured** — both the GPU and the CPU delegate fail without a context. Same requirement as Live2D, which did render inside Attendee, so the two stand or fall together. |
| It runs inside Attendee | **Not verified.** No live run has carried a webcam frame yet. |
| Acoustic turn-end costs no latency | **Measured** — first-audio 221–344 ms with the model off, 235–322 ms with it on, same harness. |

## The meeting path, without a meeting (2026-09-02)

`pnpm reality:attendee:sim` runs the whole path against a stand-in that speaks Attendee's REST API and
its three websockets, and launches the bot page the way Attendee launches it. Everything between the
broker and the character is production code; what is simulated is the vendor.

It found five defects in one afternoon, all of them invisible from outside and none of them reachable
without a meeting until now:

| # | Defect | Why nothing said so |
|---|---|---|
| 1 | **Deadlock on any vendor without its own transcripts.** Audio was gated on "have we been addressed", and on Attendee the only recogniser is the AI's — so no audio, no transcript, never addressed, no audio. | Every counter looked healthy. The character sat in the meeting thinking. |
| 2 | **The outbound converter ignored the frame's sample rate**, assuming 48 kHz. Attendee sends 16 kHz, so one sample in three became the whole signal. | No error. The recogniser received confident nonsense, at a third of real time. |
| 3 | **An explicit engine choice was silently served by another vendor** when a health probe failed. A bot page asking for the local agent was handed a cloud account with no credit. | This is the 429 that killed the first live run. |
| 4 | **The character was pushed into the meeting twice** — once through the page's speaker, which the vendor captures, and again down the socket. | 332 duplicate chunks in one run; in a call it would have been an echo nobody could explain. |
| 5 | **A bot page reports nothing.** No operator, no UI, no logs. | Three separate failures were diagnosed by rebuilding to add a log line. There is now a heartbeat. |

Final state of the run: every row passes, and the character speaks for 9.7 s.

| step | result |
|---|---|
| broker asks for all three sockets | PASS |
| vendor sockets accepted | PASS (mixed, per-participant audio, per-participant video) |
| voice agent page launched and reached the call | PASS (38 s to ready) |
| page ran without errors | PASS |
| **character spoke** | **PASS — 244 buffers, 9.7 s** |
| did not also push it back down the socket | PASS |
| relay carried the streams | PASS (450 messages, 0 malformed) |
| transcripts, engagement | 5 utterances, ENGAGED → COOLDOWN → ENGAGED |

The harness scores behaviour, not only connectivity, and the same run passes across the combinations
that matter:

| run | spoke | transcripts | engagement | camera | to the model |
|---|---|---|---|---|---|
| local · addressed_only · cues | 9.8 s | 5 | ENGAGED → COOLDOWN | 157 cues, 81 with a face | 0 (correct) |
| local · open · **vision to the model** | 10.8 s | 5 | ENGAGED → COOLDOWN | 146 cues, 79 faces | 60 frames |
| **Gemini** · addressed_only · cues | 20.3 s | 5 | ENGAGED → COOLDOWN | 158 cues, 82 faces | 0 (correct) |
| local · **Zoom URL** · no camera | 10.6 s | 5 | ENGAGED → COOLDOWN | — | — |

Camera frames are real: cut from the recording of the 2026-09-02 meeting.

What this still does not prove: Attendee's own browser and its ALSA capture, its scheduling, a real
meeting's audio, and a second human. It proves everything downstream of them, which is where every
failure so far has actually been.

## Which engine (measured 2026-09-02)

Same 2–3 minute harness, same voice (Zephyr) for both Gemini rows, same room audio.

| engine | answered | turn latency p50 / p95 | reply length p50 | notes |
|---|---|---|---|---|
| **Gemini 3.1 flash-live** | 95–100 % | **1162–1222 / 1314–1586 ms** | 25–32 chars | fastest cloud path; no affective dialog or proactive audio |
| Gemini 2.5 native-audio | 100 % | **3871–5646 / 6124–11318 ms** | 13–14 chars | the only family with affective dialog and proactive audio, and 3–5× slower with shorter answers |
| Local: sherpa + gemini-3.1-flash-lite + Supertonic F1 int8 | — | first audio 1195–1658 ms | 30–40 chars | the recogniser that can actually read a meeting room |

The cloud rows are measured on the app's own screen, close-mic. **On the meeting path Gemini barely
speaks at all** — 0.7 s in 80 seconds — because addressing depends on its own input transcription,
and on the same recording where the local recogniser reads 「ゆイ、今 どう 思う？」 it returns 「 。」.

So: 3.1 flash-live for the app, local for meetings, and 2.5 native-audio only when reacting to *how*
something was said is worth three seconds of waiting for it.

## Known unverified — the next things likely to break

Two live runs, two bugs that only a live run could show (a sample rate, and a flag
whose absence produced no error). These are the ones I can name but have not yet
proved either way. None is theoretical; each has a specific failure mode.

| # | Risk | Why it is plausible | How it will be settled |
|---|---|---|---|
| 1 | ~~AudioContext suspended inside Attendee's browser~~ | **Answered from the vendor's source.** `bots/webpage_streamer/webpage_streamer.py` launches Chrome with `--autoplay-policy=no-user-gesture-required` and captures the page's own output (`alsasrc device=default`, S16LE mono 16 kHz) into the meeting. Audio needs no gesture there. Still to be seen once in a live recording. |
| 2 | ~~No WebGL in Attendee's page browser~~ | **Settled by the live run, against my prediction.** I read `--disable-gpu` with no `--enable-unsafe-swiftshader` in their launcher, reproduced `webgl2:false, webgl1:false` under those exact flags in local macOS Chrome, and called Attendee voice-only. Then the first live run put the Live2D character on the Meet tile. The flags are not the whole story — their Linux image evidently supplies a GL path mine does not — and a local reproduction of someone else's container is a hypothesis, not a measurement of it. **Attendee renders the avatar.** The `webglAvailable` guard stays: it turns a blank tile into a named error wherever WebGL really is absent, and it correctly did not fire here. |
| 3 | ~~No Attendee webhooks~~ | **Done.** `bot.state_change` is subscribed at create time and drives the record monotonically, signature verified against Attendee's canonical JSON (`X-Webhook-Signature`). Without `ATTENDEE_WEBHOOK_SECRET` a delivery is recorded as unverified rather than silently trusted. |
| 4 | ~~Join notice unsent on Attendee~~ | **Done.** The first `joined_*` state triggers `send_chat_message` once per bot. |
| 5 | ~~Attendee meetings absent from the record~~ | **Done.** The route creates an intent and the webhook advances it, so an Attendee meeting has the same lifecycle and screens as a Recall one. |

Fixed after the second live run: the harness called a leave route that did not exist,
so a bot in a meeting that stayed open would have kept running and billing. A 404 on
cleanup looks exactly like success when nobody checks.

## Cost, because it is a production requirement

Pay-as-you-go is $0.50/bot-hour, and `web_gpu` — which Live2D needs, since no other variant has WebGL —
is $1.50/hour. **Waiting-room time is billed.** Two bots doubles it, which is one more reason the two-bot
run is a transport test and not the gate. This session spent the $5 free grant: 0.92 h at 2-core and
2.97 h on GPU, mostly on debugging.
